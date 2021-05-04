/*
MIT License

 Copyright 2021 Frank Wagner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node";
import {
  TestAdapter,
  TestLoadStartedEvent,
  TestLoadFinishedEvent,
  TestRunStartedEvent,
  TestRunFinishedEvent,
  TestSuiteEvent,
  TestEvent,
  RetireEvent,
  TestSuiteInfo,
  TestInfo,
} from "vscode-test-adapter-api";
import { Log } from "vscode-test-adapter-util";
import { FindTestsRequest, IFindTestsParams, TestSuite } from "../protocol";
import { ElmTestRunner } from "./runner";
import {
  getFilesAndAllTestIds,
  getTestsRoot,
  IElmBinaries,
  mergeTopLevelSuites,
} from "./util";

/*
  Integration with Test Explorer UI
  see https://github.com/hbenl/vscode-test-adapter-api
  and https://github.com/hbenl/vscode-test-adapter-api/blob/master/src/index.ts
*/

export class ElmTestAdapter implements TestAdapter {
  private disposables: { dispose(): void }[] = [];

  private readonly testsEmitter = new vscode.EventEmitter<
    TestLoadStartedEvent | TestLoadFinishedEvent
  >();
  private readonly testStatesEmitter = new vscode.EventEmitter<
    TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent
  >();
  private readonly retireEmitter = new vscode.EventEmitter<RetireEvent>();

  get tests(): vscode.Event<TestLoadStartedEvent | TestLoadFinishedEvent> {
    return this.testsEmitter.event;
  }
  get testStates(): vscode.Event<
    TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent
  > {
    return this.testStatesEmitter.event;
  }
  get retire(): vscode.Event<RetireEvent> {
    return this.retireEmitter.event;
  }

  private isLoading = false;
  private runner: ElmTestRunner;
  private loadedSuite?: TestSuiteInfo;
  private watcher?: vscode.Disposable;

  constructor(
    private readonly workspace: vscode.WorkspaceFolder,
    private readonly elmProjectFolder: vscode.Uri,
    private readonly log: Log,
    configuredElmBinaries: () => IElmBinaries,
    private readonly getClient: (
      folder: vscode.WorkspaceFolder,
    ) => LanguageClient | undefined,
  ) {
    this.log.info(
      "Initializing Elm Test Runner adapter",
      workspace,
      elmProjectFolder,
    );

    this.disposables.push(this.testsEmitter);
    this.disposables.push(this.testStatesEmitter);
    this.disposables.push(this.retireEmitter);

    this.runner = new ElmTestRunner(
      this.workspace,
      this.elmProjectFolder,
      this.log,
      configuredElmBinaries,
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async load(): Promise<void> {
    if (this.isLoading) {
      return;
    }

    this.log.info("Loading tests");

    const client = this.getClient(this.workspace);
    if (client) {
      this.isLoading = true;
      void client.onReady().then(async () => {
        const input: IFindTestsParams = {
          workspaceRoot: this.workspace.uri.toString(),
        };
        try {
          const response = await client.sendRequest(FindTestsRequest, input);

          const id = this.workspace.name;
          const children =
            response.suites?.map((s) => toTestSuiteInfo(s, id)) ?? [];
          const suite: TestSuiteInfo = {
            type: "suite",
            label: id,
            id,
            children,
          };
          const loadedEvent: TestLoadFinishedEvent = {
            type: "finished",
            suite,
          };
          this.loadedSuite = suite;
          this.testsEmitter.fire(loadedEvent);
          this.log.info("Loaded tests");
        } catch (error) {
          this.log.info("Failed to load tests", error);
          this.testsEmitter.fire(<TestLoadFinishedEvent>{
            type: "finished",
            errorMessage: String(error),
          });
        } finally {
          this.isLoading = false;
        }
      });
    }
  }

  async run(tests: string[]): Promise<void> {
    if (this.runner.isBusy) {
      this.log.debug("Already running tests");
      return;
    }

    this.log.info("Running tests", tests);

    if (!this.loadedSuite) {
      this.log.info("Not loaded", tests);
      return;
    }

    console.debug("loaded suite", this.loadedSuite);
    const [files, testIds] = getFilesAndAllTestIds(tests, this.loadedSuite);
    this.testStatesEmitter.fire(<TestRunStartedEvent>{
      type: "started",
      tests: testIds,
    });

    try {
      const suiteOrError = await this.runner.runSomeTests(files);
      if (typeof suiteOrError === "string") {
        console.log("Error running tests", suiteOrError);
        this.testsEmitter.fire(<TestLoadFinishedEvent>{
          type: "finished",
          errorMessage: String(suiteOrError),
        });
      } else {
        this.loadedSuite = this.fireNew(this.loadedSuite, suiteOrError);
        void this.fire(suiteOrError);
      }
    } catch (err) {
      console.log("Error running tests", err);
    } finally {
      this.testStatesEmitter.fire(<TestRunFinishedEvent>{ type: "finished" });
    }
  }

  private fireNew(loaded: TestSuiteInfo, suite: TestSuiteInfo): TestSuiteInfo {
    const suite1 = mergeTopLevelSuites(loaded, suite);
    console.debug("reconcile suite", suite1, loaded, suite);
    this.testsEmitter.fire(<TestLoadFinishedEvent>{
      type: "finished",
      suite: suite1,
    });
    // await this.runner.fireNewEvents(loaded, suite, this.testStatesEmitter);
    this.watch();
    return suite1;
  }

  private async fire(suite: TestSuiteInfo): Promise<void> {
    console.debug("run suite", suite);
    await this.runner.fireEvents(suite, this.testStatesEmitter);
    this.watch();
  }

  private watch() {
    this.watcher?.dispose();
    this.watcher = undefined;

    this.watcher = vscode.workspace.onDidSaveTextDocument((e) => {
      if (this.isTestFile(e.fileName)) {
        void this.load();
      } else if (this.isSourceFile(e.fileName)) {
        this.retireEmitter.fire({});
      }
    });
  }

  private isTestFile(file: string): boolean {
    const testsRoot = getTestsRoot(this.elmProjectFolder.fsPath);
    return file.startsWith(testsRoot);
  }

  private isSourceFile(file: string): boolean {
    return file.startsWith(`${this.elmProjectFolder.fsPath}`);
  }

  cancel(): void {
    this.runner.cancel();
    this.watcher?.dispose();
  }

  dispose(): void {
    this.cancel();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }
}

function toTestSuiteInfo(
  suite: TestSuite,
  prefixId: string,
): TestSuiteInfo | TestInfo {
  const id = toId(prefixId, suite);
  return suite.tests && suite.tests.length > 0
    ? {
        type: "suite",
        id,
        label: toLabel(suite),
        file: suite.file,
        line: suite.position.line,
        children: suite.tests.map((s) => toTestSuiteInfo(s, id)),
      }
    : {
        type: "test",
        id,
        label: toLabel(suite),
        file: suite.file,
        line: suite.position.line,
      };
}

function toLabel(suite: TestSuite): string {
  return typeof suite.label === "string" ? suite.label : suite.label.join("..");
}

function toId(prefix: string, suite: TestSuite): string {
  return typeof suite.label === "string"
    ? `${prefix}/${suite.label}`
    : `${prefix}/${suite.label.join("-")}`;
}
