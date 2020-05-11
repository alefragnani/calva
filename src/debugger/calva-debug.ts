import { LoggingDebugSession, TerminatedEvent, Thread, StoppedEvent, StackFrame, Source, Scope, Handles, Variable } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import {
    debug, window, DebugConfigurationProvider, WorkspaceFolder, DebugConfiguration, CancellationToken, ProviderResult, DebugAdapterDescriptorFactory,
    DebugAdapterDescriptor, DebugSession, DebugAdapterExecutable, DebugAdapterServer, Position
} from 'vscode';
import * as util from '../utilities';
import * as Net from 'net';
import * as state from '../state';
import { basename } from 'path';
import * as docMirror from '../doc-mirror';
import * as vscode from 'vscode';
import { replWindows } from '../repl-window';
import { moveTokenCursorToBreakpoint } from './util';
import annotations from '../providers/annotations';
import { NReplSession } from '../nrepl';
const { parseEdn } = require('../../out/cljs-lib/cljs-lib');
const { cljify, jsify, cljStringify } = require('../../out/cljs-lib/cljs-lib');

const CALVA_DEBUG_CONFIGURATION: DebugConfiguration = {
    type: 'clojure',
    name: 'Calva Debug',
    request: 'attach'
};

const REQUESTS = {
    SEND_STOPPED_EVENT: 'send-stopped-event',
    SEND_TERMINATED_EVENT: 'send-terminated-event'
};

const NEED_DEBUG_INPUT_STATUS = 'need-debug-input';
const DEBUG_RESPONSE_KEY = 'debug-response';
const DEBUG_QUIT_VALUE = 'QUIT';
const LOCALS_REFERENCE = 1;
const DEBUG_INPUT_OP = 'debug-input';

async function isMap(data: string, cljSession: NReplSession): Promise<boolean> {
    const sanitizeCode = `(clojure.edn/read-string {:default str} ${JSON.stringify(data)})`;
    const sanitized = await cljSession.eval(sanitizeCode, cljSession.client.ns).value;
    const res = await cljSession.eval(`(map? ${sanitized})`, cljSession.client.ns).value;
    return res === 'true';
}

async function isCollection(data: string, cljSession: NReplSession): Promise<boolean> {
    const res = await cljSession.eval(`(seqable? ${data})`, cljSession.client.ns).value;
    return res === 'true';
}

async function getMapKeyValueStrings(map: string, cljSession: NReplSession): Promise<[[string, string]]> {
    const code = `(map (fn [[k v]] [(pr-str k) (pr-str v)]) ${map})`;
    const res = await cljSession.eval(code, cljSession.client.ns).value;
    return parseEdn(res);
}

async function appendTypes(path: string[], keyValuePairs: [[string, string]?], cljSession: NReplSession): Promise<[[string, string, string?]]> {
    const cljString = cljStringify(keyValuePairs);
    const code = `
      (map (fn [[key value]]
        (let [get-type 
              (fn get-type [edn-string]
                (let [edn (clojure.edn/read-string edn-string)]
                  (when (or (map? edn) (seqable? edn))
                    (when-not (string? edn)
                      (pr-str (type edn))))))]
          (if-let [value-type (get-type value)]
            [key value value-type]
            [key value])))
        ${cljString})`;
    const res = await cljSession.eval(code, cljSession.client.ns).value;
    return [['', '']];
}

class CalvaDebugSession extends LoggingDebugSession {

    // We don't support multiple threads, so we can use a hardcoded ID for the default thread
    static THREAD_ID = 1;

    private _variableHandles = new Handles<{inspector: string, index: number}>();

    public constructor() {
        super('calva-debug-logs.txt');
    }

    /**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

        const cljSession = util.getSession('clj');
        if (!cljSession) {
            window.showInformationMessage('You must be connected to a Clojure REPL to use debugging.');
            this.sendEvent(new TerminatedEvent());
            response.success = false;
            this.sendResponse(response);
            return;
        }

        this.setDebuggerLinesStartAt1(args.linesStartAt1);
        this.setDebuggerColumnsStartAt1(args.columnsStartAt1);

        // Build and return the capabilities of this debug adapter
        response.body = {
            ...response.body,
            supportsRestartRequest: true
        };

        this.sendResponse(response);
    }

    protected async attachRequest(response: DebugProtocol.AttachResponse, args: DebugProtocol.AttachRequestArguments): Promise<void> {

        const cljReplWindow = replWindows['clj'];

        if (cljReplWindow) {
            await cljReplWindow.startDebugMode(util.getSession('clj'));
        }

        this.sendResponse(response);
    }

    protected async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments, request?: DebugProtocol.Request): Promise<void> {

        const cljSession = util.getSession('clj');

        if (cljSession) {
            const { id, key } = state.deref().get(DEBUG_RESPONSE_KEY);
            cljSession.sendDebugInput(':continue', id, key).then(response => {
                this.sendEvent(new StoppedEvent('breakpoint', CalvaDebugSession.THREAD_ID));
            });
        } else {
            response.success = false;
        }

        this.sendResponse(response);
    }

    protected restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments, request?: DebugProtocol.Request): void {
        response.success = false;
        this.sendResponse(response);
    }

    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments, request?: DebugProtocol.Request): void {

        const cljSession = util.getSession('clj');

        if (cljSession) {
            const { id, key } = state.deref().get(DEBUG_RESPONSE_KEY);
            cljSession.sendDebugInput(':next', id, key).then(_ => {
                this.sendEvent(new StoppedEvent('breakpoint', CalvaDebugSession.THREAD_ID));
            });
        } else {
            response.success = false;
        }

        this.sendResponse(response);
    }

    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments, request?: DebugProtocol.Request): void {

        const cljSession = util.getSession('clj');

        if (cljSession) {
            const { id, key } = state.deref().get(DEBUG_RESPONSE_KEY);
            cljSession.sendDebugInput(':in', id, key).then(_ => {
                this.sendEvent(new StoppedEvent('breakpoint', CalvaDebugSession.THREAD_ID));
            });
        } else {
            response.success = false;
        }

        this.sendResponse(response);
    }

    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments, request?: DebugProtocol.Request): void {

        const cljSession = util.getSession('clj');

        if (cljSession) {
            const { id, key } = state.deref().get(DEBUG_RESPONSE_KEY);
            cljSession.sendDebugInput(':out', id, key).then(_ => {
                this.sendEvent(new StoppedEvent('breakpoint', CalvaDebugSession.THREAD_ID));
            });
        } else {
            response.success = false;
        }

        this.sendResponse(response);
    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse, request?: DebugProtocol.Request): void {
        // We do not support multiple threads. Return a dummy thread.
        response.body = {
            threads: [
                new Thread(CalvaDebugSession.THREAD_ID, 'thread 1')
            ]
        };
        this.sendResponse(response);
    }

    private async _showDebugAnnotation(value: string, document: vscode.TextDocument, line: number, column: number): Promise<void> {
        const range = new vscode.Range(line, column, line, column);
        const visibleEditor = vscode.window.visibleTextEditors.filter(editor => editor.document.fileName === document.fileName)[0];
        if (visibleEditor) {
            await vscode.window.showTextDocument(visibleEditor.document, visibleEditor.viewColumn);
        }
        const editor = visibleEditor || await vscode.window.showTextDocument(document);
        annotations.clearEvaluationDecorations(editor);
        annotations.decorateResults(value, false, range, editor);
    }

    protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments, request?: DebugProtocol.Request): Promise<void> {

        const debugResponse = state.deref().get(DEBUG_RESPONSE_KEY);
        const filePath = debugResponse.file.replace(/^(file:)/, '');
        const document = await vscode.workspace.openTextDocument(filePath);
        const positionLine = convertOneBasedToZeroBased(debugResponse.line);
        const positionColumn = convertOneBasedToZeroBased(debugResponse.column);
        const offset = document.offsetAt(new Position(positionLine, positionColumn));
        const tokenCursor = docMirror.getDocument(document).getTokenCursor(offset);

        try {
            moveTokenCursorToBreakpoint(tokenCursor, debugResponse);
        } catch (e) {
            window.showErrorMessage('An error occurred in the breakpoint-finding logic. We would love if you submitted an issue in the Calva repo with the instrumented code, or a similar reproducible case.');
            this.sendEvent(new TerminatedEvent());
            response.success = false;
            this.sendResponse(response);
            return;
        }

        const [line, column] = tokenCursor.rowCol;

        const source = new Source(basename(filePath), filePath);
        const name = tokenCursor.getFunction();
        const stackFrames = [new StackFrame(0, name, source, line + 1, column + 1)];

        response.body = {
            stackFrames,
            totalFrames: stackFrames.length
        };

        this.sendResponse(response);

        this._showDebugAnnotation(debugResponse['debug-value'], document, line, column);
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments, request?: DebugProtocol.Request): void {

        response.body = {
            scopes: [
                new Scope("Locals", LOCALS_REFERENCE, false)
            ]
        };

        this.sendResponse(response);
    }

    private async _createVariable(path: string[], value: string, cljSession: NReplSession): Promise<Variable> {
        let variablesReference = 0;
        let variableValue = value;

        const variable = {
            name: path[path.length - 1],
            value: variableValue,
            variablesReference
        };
        return variable;
    }

    protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): Promise<void> {
        const cljSession = util.getSession('clj');
        const debugResponse = state.deref().get(DEBUG_RESPONSE_KEY);
        const structuredTypes = [
            ":seq-empty",
            ":map",
            ":map-long",
            ":vector",
            ":vector-long",
            ":lazy-seq",
            ":list",
            ":list-long",
            ":set",
            ":set-long",
            ":list",
            ":list-long",
            ":map",
            ":map-long",
            ":array",
            ":array-long"
        ];
        const variables: Variable[] = [];
        let keyValuePairs: [[string, string]?] = [];

        if (args.variablesReference === LOCALS_REFERENCE) {
            keyValuePairs = debugResponse.locals;
        } else {
            const inspector = this._variableHandles.get(args.variablesReference);
        }

        let type: string;
        let inspector: any;
        let variableName: string;
        let variableValue: any;
        let variablesReference: number;
        for (let i = 0; i < debugResponse.locals.length; i++) {
            variableName = debugResponse.locals[i][0];
            variableValue = debugResponse.locals[i][1];
            variablesReference = 0;
            type = await cljSession.eval(`(orchard.inspect/value-types ${variableName})`, cljSession.client.ns).value;
            if (structuredTypes.includes(type)) {
                inspector = await cljSession.eval(`(orchard.inspect/start (orchard.inspect/fresh) ${variableName})`, cljSession.client.ns).value;
                variablesReference = this._variableHandles.create({
                    inspector,
                    index: 0
                });
            }
            // DEBUG TODO: Try adding type prop and see if it works - may need to set supportsVariableType to true in initialize request
            variables.push({
                name: variableName,
                value: variableValue,
                variablesReference: variablesReference
            });
        }

        // CANNOT DO THIS DUE TO NATURE OF EVALING IN DEBUG CONTEXT
        // CANNOT DO PROMISE.ALL WITH ASYNC EVAL CALLS INSIDE
        // const variables = await Promise.all(debugResponse.locals.map(async([key, value]) => {
        //     // Get type of variable
        //     const type = await cljSession.eval(`(type ${key})`, cljSession.client.ns).value;
        //     return {};
        // }));

        // CANNOT DO THIS EITHER FOR SAME REASON AS PROMISE.ALL
        // debugResponse.locals.forEach(async ([key, value]) => {
        //     const type = await cljSession.eval(`(type ${key})`, cljSession.client.ns).value;
        //     console.log(key);
        // });

        response.body = {
            variables
        };
        this.sendResponse(response);
    }

    protected async disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): Promise<void> {

        const cljSession = util.getSession('clj');

        if (cljSession) {
            const { id, key } = state.deref().get(DEBUG_RESPONSE_KEY);
            cljSession.sendDebugInput(':quit', id, key);
        }

        const cljReplWindow = replWindows['clj'];

        if (cljReplWindow) {
            cljReplWindow.stopDebugMode();
        }

        this.sendResponse(response);
    }

    protected terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments, request?: DebugProtocol.Request): void {

        this.sendResponse(response);
    }

    protected customRequest(command: string, response: DebugProtocol.Response, args: any, request?: DebugProtocol.Request): void {

        switch (command) {
            case REQUESTS.SEND_TERMINATED_EVENT: {
                this.sendEvent(new TerminatedEvent());
                break;
            }
            case REQUESTS.SEND_STOPPED_EVENT: {
                this.sendEvent(new StoppedEvent(args.reason, CalvaDebugSession.THREAD_ID, args.exceptionText));
                break;
            }
        }

        this.sendResponse(response);
    }
}

CalvaDebugSession.run(CalvaDebugSession);

class CalvaDebugConfigurationProvider implements DebugConfigurationProvider {

	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
    resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {

        // If launch.json is missing or empty
        if (!config.type && !config.request && !config.name) {
            const editor = window.activeTextEditor;
            if (editor && editor.document.languageId === 'clojure') {
                config = { ...config, ...CALVA_DEBUG_CONFIGURATION };
            }
        }

        return config;
    }
}

class CalvaDebugAdapterDescriptorFactory implements DebugAdapterDescriptorFactory {

    private server?: Net.Server;

    createDebugAdapterDescriptor(session: DebugSession, executable: DebugAdapterExecutable | undefined): ProviderResult<DebugAdapterDescriptor> {

        if (!this.server) {
            // Start listening on a random port (0 means an arbitrary unused port will be used)
            this.server = Net.createServer(socket => {
                const debugSession = new CalvaDebugSession();
                debugSession.setRunAsServer(true);
                debugSession.start(<NodeJS.ReadableStream>socket, socket);
            }).listen(0);
        }

        // Make VS Code connect to debug server
        return new DebugAdapterServer(this.server.address().port);
    }

    dispose() {
        if (this.server) {
            this.server.close();
        }
    }
}

function handleNeedDebugInput(response: any): void {

    // Make sure the form exists in the editor and was not instrumented in the repl window
    if (typeof response.file === 'string'
        && typeof response.column === 'number'
        && typeof response.line === 'number') {

        state.cursor.set(DEBUG_RESPONSE_KEY, response);

        if (!debug.activeDebugSession) {
            debug.startDebugging(undefined, CALVA_DEBUG_CONFIGURATION);
        }
    } else {
        const cljSession = state.deref().get('clj');
        cljSession.sendDebugInput(':quit', response.id, response.key);
        vscode.window.showInformationMessage('Forms containing breakpoints that were not evaluated in the editor (such as if you evaluated a form in the REPL window) cannot be debugged. Evaluate the form in the editor in order to debug it.');
    }
}

debug.onDidStartDebugSession(session => {
    // We only start debugger sessions when a breakpoint is hit
    session.customRequest(REQUESTS.SEND_STOPPED_EVENT, { reason: 'breakpoint' });
});

function convertOneBasedToZeroBased(n: number): number {
    // Zero implies ignoring the line/column in the vscode-debugadapter StackFrame class, and perhaps in cider-nrepl as well
    return n === 0 ? n : n - 1;
}

export {
    CALVA_DEBUG_CONFIGURATION,
    REQUESTS,
    NEED_DEBUG_INPUT_STATUS,
    DEBUG_RESPONSE_KEY,
    DEBUG_QUIT_VALUE,
    DEBUG_INPUT_OP,
    CalvaDebugConfigurationProvider,
    CalvaDebugAdapterDescriptorFactory,
    handleNeedDebugInput
};