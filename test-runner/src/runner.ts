/**
 * Copyright Microsoft Corporation. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import child_process from 'child_process';
import crypto from 'crypto';
import path from 'path';
import { EventEmitter } from 'events';
import { lookupRegistrations, FixturePool } from './fixtures';
import { Suite, Test } from './test';
import { TestRunnerEntry, SerializedTest } from './testRunner';
import { RunnerConfig } from './runnerConfig';
import { Reporter } from './reporter';

export class Runner {
  private _workers = new Set<Worker>();
  private _freeWorkers: Worker[] = [];
  private _workerClaimers: (() => void)[] = [];
  stats: { duration: number; failures: number; passes: number; skipped: number; tests: number; };

  private _testById = new Map<string, Test>();
  private _queue: TestRunnerEntry[] = [];
  private _stopCallback: () => void;
  readonly _config: RunnerConfig;
  private _suite: Suite;
  private _reporter: Reporter;

  constructor(suite: Suite, config: RunnerConfig, reporter: Reporter) {
    this._config = config;
    this._reporter = reporter;
    this.stats = {
      duration: 0,
      failures: 0,
      passes: 0,
      skipped: 0,
      tests: 0,
    };

    this._suite = suite;
    for (const suite of this._suite.suites) {
      suite.findTest(test => {
        this._testById.set(`${test._ordinal}@${suite.file}::[${suite._configurationString}]`, test);
      });
    }

    if (process.stdout.isTTY) {
      const total = suite.total();
      console.log();
      const jobs = Math.min(config.jobs, suite.suites.length);
      console.log(`Running ${total} test${ total > 1 ? 's' : '' } using ${jobs} worker${ jobs > 1 ? 's' : ''}`);
    }
  }

  _filesSortedByWorkerHash(): TestRunnerEntry[] {
    const result: TestRunnerEntry[] = [];
    for (const suite of this._suite.suites) {
      const ordinals: number[] = [];
      suite.findTest(test => ordinals.push(test._ordinal) && false);
      if (!ordinals.length)
        continue;
      result.push({
        ordinals,
        file: suite.file,
        configuration: suite.configuration,
        configurationString: suite._configurationString,
        hash: suite._configurationString + '@' + computeWorkerHash(suite.file)
      });
    }
    result.sort((a, b) => a.hash < b.hash ? -1 : (a.hash === b.hash ? 0 : 1));
    return result;
  }

  async run() {
    this._reporter.onBegin(this._config, this._suite);
    this._queue = this._filesSortedByWorkerHash();
    // Loop in case job schedules more jobs
    while (this._queue.length)
      await this._dispatchQueue();
    this._reporter.onEnd();
  }

  async _dispatchQueue() {
    const jobs = [];
    while (this._queue.length) {
      const entry = this._queue.shift();
      const requiredHash = entry.hash;
      let worker = await this._obtainWorker();
      while (worker.hash && worker.hash !== requiredHash) {
        this._restartWorker(worker);
        worker = await this._obtainWorker();
      }
      jobs.push(this._runJob(worker, entry));
    }
    await Promise.all(jobs);
  }

  async _runJob(worker, entry) {
    worker.run(entry);
    let doneCallback;
    const result = new Promise(f => doneCallback = f);
    worker.once('done', params => {
      if (!params.failedTestId && !params.fatalError) {
        this._workerAvailable(worker);
        doneCallback();
        return;
      }

      // When worker encounters error, we will restart it.
      this._restartWorker(worker);

      // In case of fatal error, we are done with the entry.
      if (params.fatalError) {
        doneCallback();
        return;
      }

      const remaining = params.remaining;
      if (params.remaining.length)
        this._queue.unshift({ ...entry, ordinals: remaining });

      // This job is over, we just scheduled another one.
      doneCallback();
    });
    return result;
  }

  async _obtainWorker() {
    // If there is worker, use it.
    if (this._freeWorkers.length)
      return this._freeWorkers.pop();
    // If we can create worker, create it.
    if (this._workers.size < this._config.jobs)
      this._createWorker();
    // Wait for the next available worker.
    await new Promise(f => this._workerClaimers.push(f));
    return this._freeWorkers.pop();
  }

  async _workerAvailable(worker) {
    this._freeWorkers.push(worker);
    if (this._workerClaimers.length) {
      const callback = this._workerClaimers.shift();
      callback();
    }
  }

  _createWorker() {
    const worker = this._config.debug ? new InProcessWorker(this) : new OopWorker(this);
    worker.on('test', params => {
      ++this.stats.tests;
      this._reporter.onTest(this._updateTest(params.test));
    });
    worker.on('skipped', params => {
      ++this.stats.tests;
      ++this.stats.skipped;
      this._reporter.onSkippedTest(this._updateTest(params.test));
    });
    worker.on('pass', params => {
      ++this.stats.passes;
      this._reporter.onTestPassed(this._updateTest(params.test));
    });
    worker.on('fail', params => {
      ++this.stats.failures;
      this._reporter.onTestFailed(this._updateTest(params.test));
    });
    worker.on('stdout', params => {
      const chunk = chunkFromParams(params);
      const test = this._testById.get(params.testId);
      test.stdout.push(chunk);
      this._reporter.onTestStdOut(test, chunk);
    });
    worker.on('stderr', params => {
      const chunk = chunkFromParams(params);
      const test = this._testById.get(params.testId);
      test.stderr.push(chunk);
      this._reporter.onTestStdErr(test, chunk);
    });
    worker.on('exit', () => {
      this._workers.delete(worker);
      if (this._stopCallback && !this._workers.size)
        this._stopCallback();
    });
    this._workers.add(worker);
    worker.init().then(() => this._workerAvailable(worker));
  }

  async _restartWorker(worker) {
    await worker.stop();
    this._createWorker();
  }

  _updateTest(serialized: SerializedTest): Test {
    const test = this._testById.get(serialized.id);
    test.duration = serialized.duration;
    test.error = serialized.error;
    test.data = serialized.data;
    return test;
  }

  async stop() {
    const result = new Promise(f => this._stopCallback = f);
    for (const worker of this._workers)
      worker.stop();
    await result;
  }
}

let lastWorkerId = 0;

class Worker extends EventEmitter {
  runner: Runner;
  hash: string;

  constructor(runner) {
    super();
    this.runner = runner;
  }

  run(entry: TestRunnerEntry) {
  }

  stop() {
  }
}

class OopWorker extends Worker {
  process: child_process.ChildProcess;
  stdout: any[];
  stderr: any[];
  constructor(runner: Runner) {
    super(runner);

    this.process = child_process.fork(path.join(__dirname, 'worker.js'), {
      detached: false,
      env: {
        FORCE_COLOR: process.stdout.isTTY ? '1' : '0',
        DEBUG_COLORS: process.stdout.isTTY ? '1' : '0',
        ...process.env
      },
      // Can't pipe since piping slows down termination for some reason.
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    this.process.on('exit', () => this.emit('exit'));
    this.process.on('error', (e) => {});  // do not yell at a send to dead process.
    this.process.on('message', message => {
      const { method, params } = message;
      this.emit(method, params);
    });
  }

  async init() {
    this.process.send({ method: 'init', params: { workerId: lastWorkerId++, ...this.runner._config } });
    await new Promise(f => this.process.once('message', f));  // Ready ack
  }

  run(entry: TestRunnerEntry) {
    this.hash = entry.hash;
    this.process.send({ method: 'run', params: { entry, config: this.runner._config } });
  }

  stop() {
    this.process.send({ method: 'stop' });
  }
}

class InProcessWorker extends Worker {
  fixturePool: FixturePool<RunnerConfig>;

  constructor(runner: Runner) {
    super(runner);
    this.fixturePool = require('./testRunner').fixturePool as FixturePool<RunnerConfig>;
  }

  async init() {
    const { initializeImageMatcher } = require('./expect');
    initializeImageMatcher(this.runner._config);
  }

  async run(entry: TestRunnerEntry) {
    delete require.cache[entry.file];
    const { TestRunner } = require('./testRunner');
    const testRunner = new TestRunner(entry, this.runner._config, 0);
    for (const event of ['test', 'skipped', 'pass', 'fail', 'done', 'stdout', 'stderr'])
      testRunner.on(event, this.emit.bind(this, event));
    testRunner.run();
  }

  async stop() {
    await this.fixturePool.teardownScope('worker');
    this.emit('exit');
  }
}

function chunkFromParams(params: { testId: string, buffer?: string, text?: string }): string | Buffer {
  if (typeof params.text === 'string')
    return params.text;
  return Buffer.from(params.buffer, 'base64');
}

function computeWorkerHash(file: string) {
  // At this point, registrationsByFile contains all the files with worker fixture registrations.
  // For every test, build the require closure and map each file to fixtures declared in it.
  // This collection of fixtures is the fingerprint of the worker setup, a "worker hash".
  // Tests with the matching "worker hash" will reuse the same worker.
  const hash = crypto.createHash('sha1');
  for (const registration of lookupRegistrations(file, 'worker').values())
    hash.update(registration.location);
  return hash.digest('hex');
}
