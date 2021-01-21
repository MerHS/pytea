/*
 * pyteaUtils.ts
 * Copyright (c) Seoul National University.
 * Licensed under the MIT license.
 * Author: Ho Young Jhoo (mersshs@gmail.com)
 *
 * Utility functions for PyTea service.
 */
import { spawn } from 'child_process';
import { CommandLineOptions } from 'command-line-args';
import * as fs from 'fs';
import * as path from 'path';
import { ContextSet } from 'src/backend/context';
import tmp from 'tmp';
import * as util from 'util';

import { getFileInfo } from 'pyright-internal/analyzer/analyzerNodeInfo';
import { AnalyzerService } from 'pyright-internal/analyzer/service';
import { ConfigOptions } from 'pyright-internal/common/configOptions';
import { ConsoleInterface } from 'pyright-internal/common/console';
import { combinePaths, getPathComponents, normalizePath } from 'pyright-internal/common/pathUtils';
import { convertOffsetToPosition } from 'pyright-internal/common/positionUtils';
import { ParseNode, ParseNodeType } from 'pyright-internal/parser/parseNodes';

import { TorchIRFrontend } from '../frontend/torchFrontend';
import { ThStmt } from '../frontend/torchStatements';
import { defaultOptions, PyteaOptions, PyteaOptionsPart } from './pyteaOptions';

export class NodeConsole implements ConsoleInterface {
    logger: ReturnType<typeof util.debuglog>;

    constructor(loggerName: string) {
        this.logger = util.debuglog(loggerName);
    }

    warn(message: string) {
        this.logger('\n' + message + '\n');
    }

    info(message: string) {
        this.logger('\n' + message + '\n');
    }

    log(message: string) {
        this.logger('\n' + message + '\n');
    }

    error(message: string) {
        this.logger('\nERROR: ' + message + '\n');
    }
}

export function buildPyteaOption(args: CommandLineOptions): PyteaOptions | string {
    const cwd = path.normalize(process.cwd());

    const rawEntryPath: string = args['file'];
    const rawConfigPath: string = args['configPath'];
    const rawLibPath: string = args.libPath ? normalizePath(combinePaths(cwd, args.libPath)) : '';

    const entryPath: string = rawEntryPath ? normalizePath(combinePaths(cwd, rawEntryPath)) : '';
    let configPath: string = rawConfigPath ? normalizePath(combinePaths(cwd, rawConfigPath)) : '';

    if (!configPath && !entryPath) {
        return `neither configPath nor file path is found: ${entryPath}`;
    }
    if (entryPath && !fs.existsSync(entryPath)) {
        return `file path '${entryPath}' does not exist`;
    }

    let options: PyteaOptionsPart = {};
    options.configPath = configPath;

    // find config by entryPath if configPath is not set
    if (!configPath && entryPath) {
        let isDir = false;
        if (fs.lstatSync(entryPath).isDirectory()) {
            isDir = true;
        }
        const dirPath = isDir ? entryPath : path.dirname(entryPath);
        configPath = combinePaths(dirPath, 'pyteaconfig.json');
    }

    if (configPath && !fs.existsSync(configPath)) {
        console.log(`config json '${configPath}' does not exist. use default options`);
        configPath = '';
    }

    let dirPath: string;

    try {
        if (configPath) {
            dirPath = path.dirname(configPath);
            options = JSON.parse(fs.readFileSync(configPath).toString());
            if (options.entryPath) options.entryPath = normalizePath(combinePaths(dirPath, options.entryPath));
        } else {
            options = { ...defaultOptions };
        }
    } catch (e) {
        throw `'${configPath}' is not a valid JSON file`;
    }

    // entry path is explicitly given
    if (entryPath) options.entryPath = entryPath;

    if (!options.entryPath || !fs.existsSync(options.entryPath)) {
        return `file path '${options.entryPath}' does not exist`;
    }

    dirPath = path.dirname(options.entryPath);

    if (rawLibPath) {
        options.pyteaLibPath = rawLibPath;
    } else if (!options.pyteaLibPath) {
        // default libpath should be bundled with pytea.js
        options.pyteaLibPath = path.join(__dirname, 'pylib');
    } else {
        options.pyteaLibPath = normalizePath(combinePaths(dirPath, options.pyteaLibPath));
    }

    if (!fs.existsSync(options.pyteaLibPath)) {
        return `pytea library path '${options.pyteaLibPath}' does not exist`;
    }

    options = { ...defaultOptions, ...options };

    // override by runtime node args
    if (args.logLevel !== undefined) options.logLevel = args.logLevel;
    if (args.extractIR !== undefined) options.extractIR = args.extractIR;

    return options as PyteaOptions;
}

// return every .py filenames
// e.g.) ['LibCall.py', 'torch/__init__.py', ...]
export function getTorchLibFileNames(baseDirPath: string, configOptions: ConfigOptions): string[] {
    const fileNames: string[] = [];
    const venvPath = configOptions.venvPath
        ? combinePaths(configOptions.projectRoot, configOptions.venvPath)
        : undefined;

    function iterDir(dirPath: string, prefix: string): void {
        fs.readdirSync(dirPath, { withFileTypes: true }).forEach((dirent) => {
            const fullPath = path.join(dirPath, dirent.name);
            const relPath = path.join(prefix, dirent.name);

            // ignore venv
            if (venvPath && fullPath === venvPath) {
                return;
            }
            if (dirent.isDirectory()) {
                // ignore venv
                if (fs.existsSync(path.join(fullPath, 'pyvenv.cfg'))) {
                    return;
                }
                iterDir(fullPath, relPath);
            } else if (dirent.isFile()) {
                if (path.extname(dirent.name) === '.py') {
                    fileNames.push(relPath);
                }
            }
        });
    }

    iterDir(baseDirPath, '');

    return fileNames;
}

// filePath should be relative to import base directory.
// e.g.) torch/functional.py => torch.functional
//       torch/__init__.py => torch
export function filePathToQualId(path: string): string {
    const dotPaths = getPathComponents(path)
        .filter((comp) => !['', '.', '..'].includes(comp))
        .join('.');

    if (dotPaths.endsWith('.py')) {
        return dotPaths.slice(0, -3);
    } else if (dotPaths.endsWith('.__init__.py')) {
        return dotPaths.slice(0, -12);
    }

    return dotPaths;
}

// return module qualPath => ThStmt
// e.g.) "torch.functional" => <some statement>
export function getStmtsFromDir(service: AnalyzerService, dirPath: string): Map<string, ThStmt> {
    // Always enable "test mode".
    const parser = new TorchIRFrontend();
    const configOptions = service.getConfigOptions();

    const libFileNames = getTorchLibFileNames(dirPath, configOptions);
    const libFilePaths = libFileNames.map((fn) => path.resolve(dirPath, fn));

    const program = service.backgroundAnalysisProgram.program;
    program.setTrackedFiles(libFilePaths);

    while (program.analyze()) {
        // Continue to call analyze until it completes. Since we're not
        // specifying a timeout, it should complete the first time.
    }

    // analyze single pytorch entry file
    const libMap: Map<string, ThStmt> = new Map();
    for (const fpId in libFilePaths) {
        const fp = libFilePaths[fpId];
        const fn = libFileNames[fpId];

        if (fp.endsWith('LibCall.py')) {
            continue;
        }

        const sourceFile = program.getSourceFile(fp);
        if (!sourceFile) {
            console.log(`Source file not found for ${fp}`);
            continue;
        }

        let stmt: ThStmt | undefined;
        try {
            const parseResult = service.getParseResult(fp);

            if (parseResult?.parseTree) {
                stmt = parser.translate(parseResult.parseTree);
            }
        } catch (e) {
            console.log(`Frontend parse failed: ${fp}\n${e}`);
            continue;
        }

        if (!stmt) {
            console.log(`library script parse error: ${fp}`);
        } else {
            libMap.set(filePathToQualId(fn), stmt);
        }
    }

    return libMap;
}

// 'src.module.A' -> ['src', 'src.module', 'src.module.A']
// '..A.B' (from ..A import B) -> ['..', '..A', '..A.B']
// '.A.B', 'C.D' -> ['C', 'C.A', 'C.A.B']
// '..A', 'C.D.E' -> ['C', 'C.A']
export function scanQualPath(qualPath: string, currPath?: string): string[] {
    let leadingDots = 0;
    while (leadingDots < qualPath.length && qualPath[leadingDots] === '.') {
        leadingDots++;
    }

    const paths = qualPath.substr(leadingDots).split('.');
    for (let i = 0; i < paths.length - 1; i++) {
        paths[i + 1] = `${paths[i]}.${paths[i + 1]}`;
    }
    if (leadingDots > 0) {
        if (currPath === undefined) {
            const dots = '.'.repeat(leadingDots);
            return [dots, ...paths.map((p) => dots + p)];
        } else {
            const basePaths = scanQualPath(currPath);
            basePaths.splice(-leadingDots, leadingDots);

            if (basePaths.length === 0) {
                return paths;
            } else {
                const base = basePaths[basePaths.length - 1];
                paths.forEach((p) => basePaths.push(`${base}.${p}`));
                return basePaths;
            }
        }
    } else {
        return paths;
    }
}

export function runZ3Py<T>(result: ContextSet<T>): void {
    const pyteaPath = path.join(__dirname, 'z3wrapper', 'json2z3.py');

    if (!fs.existsSync(pyteaPath)) {
        console.log(`cannot found json2z3.py at '${pyteaPath}'. skip z3`);
        return;
    }

    const jsonList: string[] = [];
    result.getList().forEach((ctx) => {
        jsonList.push(ctx.ctrSet.getConstraintJSON());
    });
    result.getStopped().forEach((ctx) => {
        jsonList.push(ctx.ctrSet.getConstraintJSON());
    });

    if (jsonList.length === 0) {
        return;
    }

    const jsonStr = `[\n${jsonList.join(',\n')}\n]`;

    tmp.file((err, path) => {
        if (!err) {
            console.log(`save constraint json file to ${path}`);
            fs.writeFileSync(path, jsonStr);
            spawn('python', [pyteaPath, path]);
        }
    });
}

export function exportConstraintSet<T>(result: ContextSet<T>, path: string): void {
    const jsonList: string[] = [];
    result.getList().forEach((ctx) => {
        jsonList.push(ctx.ctrSet.getConstraintJSON());
    });
    result.getStopped().forEach((ctx) => {
        jsonList.push(ctx.ctrSet.getConstraintJSON());
    });

    const jsonStr = `[\n${jsonList.join(',\n')}\n]`;
    fs.writeFileSync(path, jsonStr);
}

export function formatParseNode(node?: ParseNode): string {
    if (!node) {
        return 'internal';
    }
    let moduleNode = node;
    while (moduleNode.nodeType !== ParseNodeType.Module) {
        moduleNode = moduleNode.parent!;
    }

    const fileInfo = getFileInfo(moduleNode)!;

    const filePath = fileInfo.filePath;
    const lines = fileInfo.lines;
    const start = convertOffsetToPosition(node.start, lines);
    const end = convertOffsetToPosition(node.start + node.length, lines);

    const relPath = path.relative(process.cwd(), filePath);

    return `[${start.line + 1}:${start.character} - ${end.line + 1}:${end.character}] @ ${relPath}`;
}
