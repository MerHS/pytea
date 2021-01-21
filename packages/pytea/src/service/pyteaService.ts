/*
 * pyteaService.ts
 * Copyright (c) Seoul National University
 * Licensed under the MIT license.
 * Author: Ho Young Jhoo (starvessel@naver.com)
 *
 * Main class of PyTea analyzer.
 * Managing imported or will be imported scripts, parsed statements and lsp services.
 */
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';

import { AnalyzerService } from 'pyright-internal/analyzer/service';
import { CommandLineOptions as PyrightCommandLineOptions } from 'pyright-internal/common/commandLineOptions';
import { ConsoleInterface, NullConsole, StandardConsole } from 'pyright-internal/common/console';
import { createFromRealFileSystem } from 'pyright-internal/common/fileSystem';

import { fetchAddr } from '../backend/backUtils';
import { ContextSet } from '../backend/context';
import { ShHeap } from '../backend/sharpEnvironments';
import { ShContFlag, ShValue, SVSize, SVString, SVType } from '../backend/sharpValues';
import { SymExp } from '../backend/symExpressions';
import { TorchBackend } from '../backend/torchBackend';
import { ThStmt } from '../frontend/torchStatements';
import { PyCmdArgs, PyteaOptions } from './pyteaOptions';
import * as PyteaUtils from './pyteaUtils';

let _globalService: PyteaService | undefined;

enum ExitStatus {
    NoErrors = 0,
    ErrorsReported = 1,
    FatalError = 2,
    ConfigFileParseError = 3,
}
export class PyteaService {
    private _options?: PyteaOptions;
    private _service?: AnalyzerService;

    private _console: ConsoleInterface;

    private _projectPath: string;
    private _entryPath: string;
    private _entryName: string;

    private _libStmt: Map<string, ThStmt>;
    private _projectStmt?: Map<string, ThStmt>;
    private _mainStmt?: ThStmt;

    private _timeLog: [string, number][];
    private _currTime: number;

    constructor(pyteaOptions: PyteaOptions, console?: ConsoleInterface, setDefault?: boolean) {
        if (setDefault) _globalService = this;

        this._console = console || new StandardConsole();

        this._timeLog = [];
        this._currTime = performance.now();

        this._projectPath = '';
        this._entryPath = '';
        this._entryName = '';

        this._options = pyteaOptions;

        this._libStmt = new Map();
    }

    get options(): PyteaOptions | undefined {
        return this._options;
    }

    static getGlobalService(): PyteaService | undefined {
        return _globalService;
    }

    static setGlobalService(service: PyteaService): void {
        _globalService = service;
    }

    static ignoreAssert(): boolean {
        const options = _globalService?.options;
        return options ? options.ignoreAssert : true;
    }

    static shouldCheckImmediate(): boolean {
        const options = _globalService?.options;
        return options ? options.immediateConstraintCheck : true;
    }

    static getCmdArgs(): PyCmdArgs {
        const options = _globalService?.options;
        return options ? options.pythonCmdArgs : {};
    }

    static getSubcommand(): string {
        const options = _globalService?.options;
        return options ? options.pythonSubcommand : '';
    }

    static log(...message: any[]): void {
        _globalService?._console.log(message.map((x) => `${x}`).join(' '));
    }

    setPyrightAnalyzerService(service: AnalyzerService) {
        if (this._service !== service) {
            this._service?.dispose();
        }

        this._service = service;
    }

    // check library or entry file is fully loaded.
    validate(): boolean {
        let valid = true;

        if (!this._service) {
            this._console.error('Pyright service is not set.');
        }

        if (!this._options) {
            this._console.error('PyTea service option is not set. Please check pyteaconfig.json.');
        }

        if (!this._entryPath) {
            this._console.error('Python entry point is not set.');
            valid = false;
        }

        if (!this._projectStmt || this._projectStmt.size === 0) {
            this._console.error('Project directory is empty');
            valid = false;
        }

        if (!this._options?.pyteaLibPath || this._libStmt.size === 0) {
            this._console.error('Invalid PyTea library path. Please check library path correctly.');
            valid = false;
        }

        return valid;
    }

    // return error message (string) or undefined
    translateMainEntry(entryPath: string): string | undefined {
        if (!entryPath) {
            return 'path is blank';
        }

        if (!fs.existsSync(entryPath)) {
            return `path ${entryPath} does not exists`;
        }

        if (path.extname(entryPath) !== '.py') {
            return `entry point ${entryPath} is not a python script`;
        }

        if (!this._service) {
            return `pyright service is not set.`;
        }

        this._clearTimeLog();

        this._entryPath = entryPath;
        this._entryName = path.basename(entryPath, path.extname(entryPath));

        // translate pytea library implementations
        if (this._libStmt.size === 0 && this._service && this._options?.pyteaLibPath) {
            this._libStmt = PyteaUtils.getStmtsFromDir(this._service, this._options.pyteaLibPath);
            this._pushTimeLog('Translate library scripts');
        }

        // translate project scripts
        this._projectPath = path.join(entryPath, '..');
        this._projectStmt = PyteaUtils.getStmtsFromDir(this._service, this._projectPath);

        this._pushTimeLog('Translate project scripts');

        return;
    }

    analyze(): ContextSet<ShValue | ShContFlag> | undefined {
        if (!this.validate()) {
            this._console.error('failed to validate PyTea service.');
            return;
        }

        const builtins = this._libStmt.get('builtins');
        if (!builtins) {
            this._console.error('cannot find PyTea implemenation of Python builtins.');
            return;
        }

        // TODO: consistent pyteaLibPath
        const builtinSet = TorchBackend.runBuiltin(builtins, 'builtins');
        const stmt = this._projectStmt?.get(this._entryName);

        if (!stmt) {
            this._mainStmt = undefined;
            this._console.error(`cannot parse entry file '${this._entryPath}'`);
            return;
        }

        this._pushTimeLog('Running builtin libraries');

        this._mainStmt = stmt;

        const startSet = builtinSet.map((ctx) => {
            // set __name__ to '__main__'
            const [nameAddr, newHeap] = ctx.heap.allocNew(SVString.create('__main__'));
            return ctx.setRelPath(this._entryName).setEnv(ctx.env.setId('__name__', nameAddr)).setHeap(newHeap);
        });
        const result = TorchBackend.run(startSet, stmt);

        this._pushTimeLog('Running entry file');

        return result;
    }

    checkUnittest(passOrFail: boolean): boolean {
        if (!this.validate()) {
            this._console.error('failed to validate PyTea service.');
            return false;
        }

        const builtins = this._libStmt.get('builtins');
        if (!builtins) {
            this._console.error('cannot find PyTea implemenation of Python builtins.');
            return false;
        }

        // TODO: consistent pyteaLibPath
        const builtinSet = TorchBackend.runBuiltin(builtins, 'builtins');
        const stmt = this._projectStmt?.get(this._entryName);
        if (!stmt) {
            this._console.error(`cannot parse entry file '${this._entryPath}'`);
            return false;
        }

        this._pushTimeLog('Running builtin libraries');

        // this._console.log(ThStmt.toString(stmt));

        const startSet = builtinSet.map((ctx) => {
            // set __name__ to '__main__'
            const [nameAddr, newHeap] = ctx.heap.allocNew(SVString.create('__main__'));
            return ctx.setRelPath(this._entryName).setEnv(ctx.env.setId('__name__', nameAddr)).setHeap(newHeap);
        });
        const result = TorchBackend.run(startSet, stmt);

        this._pushTimeLog('Running entry file');

        return this._unittestLog(passOrFail, result);
    }

    // Dynamic communications with Backend
    // import resolution order: (e.g. from A.B import C)
    //      1. project script   (A/B.py)
    //      2. __init__.py from project (A/B/__init__.py)
    //      3. library script (site-packages/A/B.py)
    //      4. __init__.py from project (site-packages/A/B/__init__.py)
    //
    // boolean value indicates imported from __init__
    getImportModuleStmt(qualPath: string): [ThStmt | undefined, boolean] {
        const initPath = qualPath + '.__init__';
        if (this._projectStmt?.has(qualPath)) {
            return [this._projectStmt.get(qualPath), false];
        } else if (this._projectStmt?.has(initPath)) {
            return [this._projectStmt.get(initPath), true];
        } else if (this._libStmt.has(qualPath)) {
            return [this._libStmt.get(qualPath), false];
        } else if (this._libStmt.has(initPath)) {
            return [this._libStmt.get(initPath), true];
        }

        return [undefined, false];
    }

    printLog(result: ContextSet<ShValue | ShContFlag>): void {
        const logLevel = this._options!.logLevel;
        switch (logLevel) {
            case 'none':
                this._noneLog(result);
                break;
            case 'result-only':
                this._resultOnlyLog(result);
                break;
            case 'reduced':
                this._reducedLog(result);
                break;

            case 'full':
                this._fullLog(result);
                break;
        }
    }

    addFilesToTrack(files: string[]) {
        if (this._service) {
            this._service.dispose();
            this._service = undefined;
        }

        if (!this._options?.pyteaLibPath) {
            console.error(`cannot find pylib path`);
            return;
        }

        const options = new PyrightCommandLineOptions(process.cwd(), false);
        options.fileSpecs = files;
        options.checkOnlyOpenFiles = false;

        // ignore original pyright output.
        const output = new NullConsole();
        const realFileSystem = createFromRealFileSystem(output);

        const watch = options.watchForSourceChanges;

        const service = new AnalyzerService('<default>', realFileSystem, output);
        this.setPyrightAnalyzerService(service);

        service.setCompletionCallback((results) => {
            if (results.fatalErrorOccurred) {
                this._console.error('Pyright fatal error occured');
                this._service = undefined;
                service.dispose();
                return;
            }

            if (results.configParseErrorOccurred) {
                this._console.error('Pyright config parse error occured');
                this._service = undefined;
                service.dispose();
                return;
            }

            if (this._options) {
                const entryPath = this._options.entryPath;

                // this triggers project folder parsing.
                this.translateMainEntry(entryPath);

                if (this.validate()) {
                    // do pytea job
                    try {
                        this.analyze();
                    } catch (e) {
                        this._console.error(e);
                    }
                }
            } else {
                this._console.error('pytea option is not initialized');
            }

            if (!watch) process.exit(ExitStatus.NoErrors);
        });

        // This will trigger the analyzer.
        service.setOptions(options);
    }

    private _noneLog(result: ContextSet<ShValue | ShContFlag>): void {
        // do nothing.
    }

    private _resultOnlyLog(result: ContextSet<ShValue | ShContFlag>): void {
        const success = result.getList();
        const failed = result.getFailed();
        const stopped = result.getStopped();

        failed.forEach((ctx, i) => {
            const source = ctx.retVal.source;

            this._console.log(
                `failed path #${i + 1}: ${ctx.retVal.reason} - ${PyteaUtils.formatParseNode(source)}\n\n`
            );
        });

        this._pushTimeLog('printing results');

        this._console.log(
            chalk.green(`potential success path #: ${success.count()}\n`) +
                chalk.yellow(`potential unreachable path #: ${stopped.count()}\n`) +
                chalk.red(`immediate failed path #: ${failed.count()}\n\n`) +
                'RUNNING TIMES:\n' +
                this._timeLog.map(([name, interval]) => `  ${name}: ${(interval / 1000).toFixed(4)}s`).join('\n')
        );
    }

    private _reducedLog(result: ContextSet<ShValue | ShContFlag>): void {
        const success = result.getList();
        const failed = result.getFailed();
        const stopped = result.getStopped();

        const jsonList: string[] = [];

        if (this._mainStmt) {
            this._console.log(
                chalk.yellow(`PARSED STATEMENTS:`) + chalk.gray(`\n${ThStmt.toString(this._mainStmt)}\n`)
            );
        }

        success.forEach((ctx, i) => {
            jsonList.push(ctx.ctrSet.getConstraintJSON());

            let heapLog = '';
            // TODO: currently assume that address 1 is main module object
            //       do not hardcode.
            const module = ctx.heap.getVal(1);
            if (module?.type === SVType.Object) {
                heapLog =
                    `REDUCED HEAP: (size: ${ctx.heap.valMap.count()})\n` +
                    module.attrs
                        .map((v, k) => {
                            return `  ${k} => ${this._reducedToString(v, ctx.heap)}`;
                        })
                        .join('\n');
            }

            this._console.log(
                chalk.green(`success path #${i + 1}`) +
                    `\n\nLOGS:\n${ctx.logsToString()}\n\nCONSTRAINTS:\n${ctx.ctrSet.toString()}\n\n${heapLog}`
            );
        });

        stopped.forEach((ctx, i) => {
            jsonList.push(ctx.ctrSet.getConstraintJSON());

            const source = ctx.retVal.source;

            const heapLog = ctx.env.addrMap
                .filter((v) => v.addr >= 0)
                .map((addr, key) => {
                    return `  ${key} => ${this._reducedToString(addr, ctx.heap)}`;
                })
                .join('\n');

            this._console.log(
                chalk.yellow(`stopped path #${i + 1}`) +
                    `: ${ctx.retVal.reason} - ${PyteaUtils.formatParseNode(source)}\n\n` +
                    `LOGS:\n${ctx.logsToString()}\n\n` +
                    'CONSTRAINTS:\n' +
                    ctx.ctrSet.toString() +
                    '\n\nCALL STACK:\n' +
                    ctx.callStackToString() +
                    `\n\nREDUCED HEAP (${ctx.heap.valMap.count()}):\n${heapLog}`
            );
        });

        failed.forEach((ctx, i) => {
            const source = ctx.retVal.source;

            const heapLog = ctx.env.addrMap
                .filter((v) => v.addr >= 0)
                .map((addr, key) => {
                    return `  ${key} => ${this._reducedToString(addr, ctx.heap)}`;
                })
                .join('\n');

            this._console.log(
                chalk.red(`failed path #${i + 1}`) +
                    `: ${ctx.retVal.reason} - ${PyteaUtils.formatParseNode(source)}\n\n` +
                    `LOGS:\n${ctx.logsToString()}\n\n` +
                    'CONSTRAINTS:\n' +
                    ctx.ctrSet.toString() +
                    '\n\nCALL STACK:\n' +
                    ctx.callStackToString() +
                    `\n\nREDUCED HEAP (${ctx.heap.valMap.count()}):\n${heapLog}`
            );
        });

        this._pushTimeLog('printing results');

        this._console.log(
            chalk.green(`potential success path #: ${success.count()}\n`) +
                chalk.yellow(`potential unreachable path #: ${stopped.count()}\n`) +
                chalk.red(`immediate failed path #: ${failed.count()}\n\n`) +
                'RUNNING TIMES:\n' +
                this._timeLog.map(([name, interval]) => `  ${name}: ${(interval / 1000).toFixed(4)}s`).join('\n')
        );
    }

    private _fullLog(result: ContextSet<ShValue | ShContFlag>): void {
        const success = result.getList();
        const failed = result.getFailed();
        const stopped = result.getStopped();

        if (this._mainStmt) {
            this._console.log(
                chalk.yellow(`PARSED STATEMENTS:`) + chalk.gray(`\n${ThStmt.toString(this._mainStmt)}\n`)
            );
        }

        success.forEach((ctx, i) => {
            this._console.log(
                chalk.green(`success path #${i + 1}`) +
                    `\nLOGS:\n${ctx.logsToString()}\n` +
                    `CONSTRAINTS:\n${ctx.ctrSet.toString()}\n` +
                    `ENV:\n${ctx.env.toString()}\n` +
                    `HEAP (size: ${ctx.heap.valMap.count()}):\n${ctx.heap.filter((_, key) => key >= 0).toString()}\n`
            );
        });

        stopped.forEach((ctx, i) => {
            const source = ctx.retVal.source;

            this._console.log(
                chalk.yellow(`stopped path #${i + 1}`) +
                    `: ${ctx.retVal.reason} / at ${ctx.relPath} ${PyteaUtils.formatParseNode(source)}\n` +
                    `LOGS:\n${ctx.logsToString()}\n` +
                    'CONSTRAINTS:\n' +
                    ctx.ctrSet.toString() +
                    '\n\nCALL STACK:\n' +
                    ctx.callStackToString() +
                    `\nENV:\n${ctx.env.toString()}\n` +
                    `\nHEAP (${ctx.heap.valMap.count()}):\n${ctx.heap.filter((_, key) => key >= 0).toString()}`
            );
        });

        failed.forEach((ctx, i) => {
            const source = ctx.retVal.source;

            this._console.log(
                chalk.red(`failed path #${i + 1}`) +
                    `: ${ctx.retVal.reason} / at ${ctx.relPath} ${PyteaUtils.formatParseNode(source)}\n` +
                    `LOGS:\n${ctx.logsToString()}\n` +
                    'CONSTRAINTS:\n' +
                    ctx.ctrSet.toString() +
                    '\n\nCALL STACK:\n' +
                    ctx.callStackToString() +
                    `\nENV:\n${ctx.env.toString()}\n` +
                    `\nHEAP (${ctx.heap.valMap.count()}):\n${ctx.heap.filter((_, key) => key >= 0).toString()}`
            );
        });

        this._pushTimeLog('printing results');

        this._console.log(
            chalk.green(`potential success path #: ${success.count()}\n`) +
                chalk.yellow(`potential unreachable path #: ${stopped.count()}\n`) +
                chalk.red(`immediate failed path #: ${failed.count()}\n\n`) +
                'RUNNING TIMES:\n' +
                this._timeLog.map(([name, interval]) => `  ${name}: ${(interval / 1000).toFixed(4)}s`).join('\n')
        );
    }

    private _unittestLog(passOrFail: boolean, result: ContextSet<ShValue | ShContFlag>): boolean {
        const success = result.getList();
        const failed = result.getFailed();

        const jsonList: string[] = [];

        let hasSVError = false;

        success.forEach((ctx, i) => {
            jsonList.push(ctx.ctrSet.getConstraintJSON());

            let heapLog = '';
            // TODO: currently assume that address 1 is main module object
            //       do not hardcode.
            const module = ctx.heap.getVal(1);
            if (module?.type === SVType.Object) {
                heapLog =
                    `REDUCED HEAP: (size: ${ctx.heap.valMap.count()})\n` +
                    module.attrs
                        .map((v, k) => {
                            return `  ${k} => ${this._reducedToString(v, ctx.heap)}`;
                        })
                        .join('\n');
            }

            ctx.logs.forEach((value, i) => {
                if (value.type === SVType.Error) {
                    this._console.log(
                        `success path #${
                            i + 1
                        }\n\nLOGS:${ctx.logsToString()}\n\nCONSTRAINTS:\n${ctx.ctrSet.toString()}\n\n${heapLog}`
                    );
                    hasSVError = true;
                }
            });
        });

        if (passOrFail) {
            return failed.count() === 0 && !hasSVError;
        } else {
            return success.count() === 0 && !hasSVError;
        }
    }

    // if value is address, return fetchAddr(value, heap)
    // if that object has attr 'shape' and that is SVSize, return `Tensor ${value.size}`
    private _reducedToString(value: ShValue, heap: ShHeap): string {
        const obj = fetchAddr(value, heap);
        if (obj) {
            if (obj.type === SVType.Object) {
                const shape = obj.getAttr('shape');
                if (shape instanceof SVSize) {
                    return `Tensor ${SymExp.toString(shape.shape)}`;
                }
            }

            return obj.toString();
        } else {
            return value.toString();
        }
    }

    private _clearTimeLog(): void {
        this._currTime = performance.now();
        this._timeLog = [];
    }

    private _pushTimeLog(logName: string): void {
        const temp = this._currTime;
        this._currTime = performance.now();
        this._timeLog.push([logName, this._currTime - temp]);
    }
}
