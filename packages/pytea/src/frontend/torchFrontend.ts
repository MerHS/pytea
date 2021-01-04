/*
 * torchValues.ts
 * Copyright (c) Seoul National University.
 * Licensed under the MIT license.
 * Author: Ho Young Jhoo
 *
 * Python scripts to PyTea internal languages.
 */
import { inspect } from 'util';

import {
    ArgumentCategory,
    AssertNode,
    AssignmentNode,
    AugmentedAssignmentNode,
    BinaryOperationNode,
    BreakNode,
    CallNode,
    ClassNode,
    ConstantNode,
    ContinueNode,
    DelNode,
    DictionaryNode,
    EllipsisNode,
    ExpressionNode,
    ForNode,
    FunctionNode,
    GlobalNode,
    IfNode,
    ImportAsNode,
    ImportFromNode,
    ImportNode,
    IndexNode,
    ListNode,
    MemberAccessNode,
    ModuleNode,
    NameNode,
    NonlocalNode,
    NumberNode,
    ParameterCategory,
    ParseNode,
    ParseNodeArray,
    ParseNodeType,
    PassNode,
    RaiseNode,
    ReturnNode,
    SliceNode,
    StatementListNode,
    StringListNode,
    StringNode,
    TernaryNode,
    TupleNode,
    UnaryOperationNode,
    WhileNode,
    WithNode,
} from 'pyright-internal/parser/parseNodes';
import { KeywordType, OperatorType } from 'pyright-internal/parser/tokenizerTypes';

import { PyteaService } from '../service/pyteaService';
import {
    extractIds,
    extractLocalDef,
    extractSingleImport,
    flattenNodeArray,
    getFullAttrPath,
    parseBinOp,
    parseUnaryOp,
    toQualPath,
} from './frontUtils';
import {
    LibCallType,
    TEAttr,
    TEBinOp,
    TEBopType,
    TECall,
    TEConst,
    TEConstType,
    TELibCall,
    TEName,
    TEObject,
    TESubscr,
    TETuple,
    TEType,
    TEUnaryOp,
    TEUopType,
    ThExpr,
    ThLeftExpr,
    ThStmt,
    TSAssign,
    TSBreak,
    TSContinue,
    TSExpr,
    TSForIn,
    TSFunDef,
    TSIf,
    TSLet,
    TSPass,
    TSReturn,
    TSSeq,
} from './torchStatements';

export class TorchIRFrontend {
    private _immId: number;

    constructor() {
        this._immId = 0;
    }

    translate(node: ParseNode): ThStmt {
        this._immId = 0;

        const parser = new TorchIRFrontend();
        const stmt = parser.visitNode(node);

        if ('stype' in stmt) {
            return stmt;
        } else {
            return TSExpr.create(stmt);
        }
    }

    visitArray(nodes: ParseNodeArray): ThStmt {
        const arr = flattenNodeArray(nodes);
        const localStack: ThStmt[] = [];

        for (const [idx, node] of arr.entries()) {
            if (!node) continue;

            if (node.nodeType === ParseNodeType.Function) {
                const [name, params, body] = this.visitFunction(node);
                const tempName = TEName.create(`${name}$TMP$`, node.name);

                let stmt = this.visitArray(arr.slice(idx + 1));

                // varargs and kwargs
                const setDefaultParams: [string, ThExpr][] = [
                    ['$func', tempName],
                    ...node.parameters
                        .filter((param) => param.defaultValue !== undefined)
                        .map(
                            (param) => [param.name!.value, this.visitExprNode(param.defaultValue!)] as [string, ThExpr]
                        ),
                ];
                const varargs = node.parameters.findIndex((param) => param.category === ParameterCategory.VarArgList);
                const kwargs = node.parameters.findIndex(
                    (param) => param.category === ParameterCategory.VarArgDictionary
                );

                let keyOnlyNum = 0;
                if (varargs >= 0) {
                    setDefaultParams.push(['$varargsName', TEConst.genStr(node.parameters[varargs].name!.value)]);
                    keyOnlyNum = node.parameters.length - varargs - 1;
                }
                if (kwargs >= 0) {
                    setDefaultParams.push(['$kwargsName', TEConst.genStr(node.parameters[kwargs].name!.value)]);
                    keyOnlyNum -= 1;
                }

                if (keyOnlyNum > 0) setDefaultParams.push(['$keyOnlyNum', TEConst.genInt(keyOnlyNum)]);

                const resetStmts = [stmt];

                if (setDefaultParams.length > 1) {
                    const setDefault = TELibCall.create(LibCallType.setDefault, setDefaultParams, node);
                    resetStmts.unshift(TSAssign.create(TEName.create(name, node.name), setDefault));
                } else {
                    resetStmts.unshift(TSAssign.create(TEName.create(name, node.name), tempName));
                }

                stmt = this._mergeStmt(resetStmts);

                localStack.push(TSFunDef.create(tempName.ident, params, body, stmt, node));
                break;
            }

            let stmt = this.visitNode(node);
            if ('etype' in stmt) {
                stmt = TSExpr.create(stmt);
            }
            localStack.push(stmt);
        }

        return this._mergeStmt(localStack);
    }

    visitModule(node: ModuleNode): ThStmt {
        const localDef = extractLocalDef(node.statements);
        const singleImport = extractSingleImport(node.statements);
        const stmt = this.visitArray(node.statements);
        stmt.source = node;

        // assign global variables and functions to '$module'
        localDef.delete('LibCall');

        const noImport = new Set(localDef);
        singleImport.forEach((im) => {
            noImport.delete(im);
        });

        const moduleName = TEName.create('$module');
        const moduleExport = TSSeq.create(
            stmt,
            this._mergeStmt(
                // CAVEAT: do not import global variables that has name starting with '__'
                [...noImport.values()]
                    .filter((name) => !name.startsWith('__'))
                    .map((name) =>
                        TSExpr.create(
                            TELibCall.create(LibCallType.exportGlobal, [
                                ['$module', moduleName],
                                [name, TEName.create(name)],
                            ])
                        )
                    )
            )
        );

        return TSLet.create('$module', this._mergeLocalDef(localDef, moduleExport), TEObject.create());
    }

    visitNonlocal(node: NonlocalNode): ThStmt {
        return TSPass.get(node);
    }

    visitGlobal(node: GlobalNode): ThStmt {
        return TSPass.get(node);
    }

    visitImport(node: ImportNode): ThStmt {
        return this._mergeStmt(node.list.map((n) => this.visitImportAs(n)));
    }

    visitImportAs(node: ImportAsNode): ThStmt {
        //      import(qualifiedPath: string) -> return PyModule like object
        //      importQualified(qualifiedPath: string) -> Assign PyModule like object to qualified path

        // LibCall check
        // TODO: pyright based LibCall path check.
        const nameParts = node.module.nameParts;
        if (nameParts.length > 0 && nameParts[nameParts.length - 1].value === 'LibCall') {
            // each LibCall will be replaced in-place
            return TSPass.get();
        }

        const path = TEConst.genStr(toQualPath(node.module));
        const qualPath: [string, ThExpr][] = [['qualPath', path]];
        if (!node.alias && node.module.nameParts.length >= 2) {
            // import x.y
            return TSExpr.create(TELibCall.create(LibCallType.importQualified, qualPath, node));
        } else {
            const nameNode = node.alias ? node.alias : node.module.nameParts[0];
            const name = nameNode.value;
            qualPath.push(['assignTo', TEConst.genStr(name, nameNode)]);

            return TSExpr.create(TELibCall.create(LibCallType.import, qualPath, node));
        }
    }

    visitImportFrom(node: ImportFromNode): ThStmt {
        const imports = node.imports;
        if (imports.length > 0 && imports[imports.length - 1].name.value === 'LibCall') {
            // each LibCall will be replaced in-place
            return TSPass.get();
        }

        let basepath = toQualPath(node.module);
        if (basepath.endsWith('.')) {
            basepath = basepath.substr(0, basepath.length - 1);
        }

        const stmts: ThStmt[] = [];

        const isWild = node.isWildcardImport;
        if (isWild) {
            const qualPath: [string, ThExpr][] = [['qualPath', TEConst.genStr(`${basepath}.*`, node.module)]];
            stmts.push(TSExpr.create(TELibCall.create(LibCallType.import, qualPath, node.module)));
        } else {
            node.imports.forEach((from) => {
                const qualPath: [string, ThExpr][] = [
                    ['qualPath', TEConst.genStr(`${basepath}.${from.name.value}`, from.name)],
                ];

                const nameNode = from.alias ? from.alias : from.name;
                const name = nameNode.value;
                qualPath.push(['assignTo', TEConst.genStr(name, nameNode)]);

                stmts.push(TSExpr.create(TELibCall.create(LibCallType.import, qualPath, node)));
            });
        }

        return this._mergeStmt(stmts);
    }

    visitClass(node: ClassNode): ThStmt {
        // TODO: resolve MRO
        const name = TEName.create(node.name.value, node.name);
        const suite = flattenNodeArray(node.suite.statements);
        const stmts: ThStmt[] = [];
        const props: AssignmentNode[] = [];
        const methods: FunctionNode[] = [];

        let initFunc: FunctionNode | undefined = undefined;
        let hasCall = false;

        suite.forEach((inner) => {
            if (inner.nodeType === ParseNodeType.Assignment) {
                stmts.push(this._visitClassProp(node, inner));
                props.push(inner);
            } else if (inner.nodeType === ParseNodeType.Function) {
                if (inner.name.value === '__init__') {
                    initFunc = inner;
                    stmts.unshift(this._genClassInit(node, inner));
                    methods.push(inner);
                } else if (inner.name.value !== '__new__') {
                    // ignore user defined __new__ and __call__
                    if (inner.name.value === '__call__') {
                        hasCall = true;
                    }

                    stmts.push(this._visitClassMethod(node, inner, inner.name.value === '__call__'));
                    methods.push(inner);
                }
            }
        });

        if (!initFunc) {
            stmts.unshift(this._genClassInit(node));
        }

        stmts.push(this._genClassNew(node, hasCall));
        stmts.push(this._genClassCall(node, initFunc));
        const superClasses = [
            name,
            ...node.arguments.map((arg) => this.visitExprNode(arg.valueExpression)),
            TEName.create('object'),
        ];

        return this._mergeStmt([
            TSAssign.create(name, TEObject.create(), node.name),
            ...stmts,
            TSAssign.create(TEAttr.create(name, '__mro__'), TETuple.create(superClasses)),
            TSAssign.create(TEAttr.create(name, '__name__'), TEConst.genStr(node.name.value, node.name)),
        ]);
    }

    private _visitClassMethod(node: ClassNode, method: FunctionNode, isCall?: boolean): ThStmt {
        // TODO: staticmethod
        const funcRawName = isCall ? 'self$call' : method.name.value;
        const funcName = TEName.create(`${node.name.value}$${funcRawName}`, method.name);
        const className = TEName.create(node.name.value, node.name);
        const selfParam = method.parameters[0].name!;
        const selfName = TEName.create(selfParam.value, selfParam);
        const localDef = extractLocalDef(
            method.suite.statements,
            method.parameters.map((p) => p.name?.value)
        );

        const stmt = TSLet.create(
            '__class__',
            TSLet.create(
                '__self__',
                TSSeq.create(this.visitArray(method.suite.statements), TSReturn.create(TEConst.genNone())),
                selfName
            ),
            className
        );

        let setStmt: ThStmt;
        if (
            method.parameters.some(
                (param) =>
                    param.category === ParameterCategory.VarArgDictionary ||
                    param.category === ParameterCategory.VarArgList ||
                    param.defaultValue !== undefined
            )
        ) {
            const paramNames: [string, ThExpr][] = [['$func', funcName]];

            let keyOnlyNum = -1;
            method.parameters.forEach((param) => {
                const paramName = param.name;
                if (paramName) {
                    if (param.category === ParameterCategory.VarArgList) {
                        paramNames.push(['$varargsName', TEConst.genStr(paramName.value)]);
                    } else if (param.category === ParameterCategory.VarArgDictionary) {
                        paramNames.push(['$kwargsName', TEConst.genStr(paramName.value)]);
                    } else if (param.defaultValue !== undefined) {
                        paramNames.push([paramName.value, this.visitExprNode(param.defaultValue)]);
                    }
                }

                if (param.category === ParameterCategory.VarArgList) keyOnlyNum = 0;
                else if (param.category !== ParameterCategory.VarArgDictionary && keyOnlyNum >= 0) keyOnlyNum += 1;
            });

            if (keyOnlyNum > 0) paramNames.push(['$keyOnlyNum', TEConst.genInt(keyOnlyNum)]);

            setStmt = TSAssign.create(
                TEAttr.create(className, funcRawName),
                TELibCall.create(LibCallType.setDefault, paramNames),
                method
            );
        } else {
            setStmt = TSAssign.create(TEAttr.create(className, funcRawName), funcName);
        }

        return TSFunDef.create(
            funcName.ident,
            method.parameters.map((param) => param.name!.value),
            this._mergeLocalDef(localDef, stmt),
            setStmt
        );
    }
    private _visitClassProp(node: ClassNode, prop: AssignmentNode): ThStmt {
        // TODO: assign non-name property
        if (prop.leftExpression.nodeType === ParseNodeType.Name) {
            return TSAssign.create(
                TEAttr.create(TEName.create(node.name.value, node.name), prop.leftExpression.value),
                this.visitExprNode(prop.rightExpression)
            );
        } else {
            return TSPass.get(prop);
        }
    }
    private _genClassInit(node: ClassNode, func?: FunctionNode): ThStmt {
        const className = TEName.create(node.name.value, node.name);
        const funcName = TEName.create(`${node.name.value}$__init__`, func?.name);
        const params = func ? func.parameters.map((p) => p.name!.value) : ['self', 'args', 'kwargs'];
        const selfName = TEName.create(params[0]);
        const localDef = func
            ? extractLocalDef(
                  func.suite.statements,
                  func.parameters.map((p) => p.name?.value)
              )
            : undefined;

        let initBody: ThStmt;

        if (!func) {
            initBody = TSLet.create(
                '__class__',
                TSLet.create(
                    '__self__',
                    TSSeq.create(
                        TSExpr.create(
                            TELibCall.create(LibCallType.callKV, [
                                [
                                    '$func',
                                    TEAttr.create(
                                        TELibCall.create(LibCallType.super, [
                                            ['baseClass', TEName.create('__class__')],
                                            ['self', TEName.create('__self__')],
                                        ]),
                                        '__init__'
                                    ),
                                ],
                                ['$varargs', TEName.create('args')],
                                ['$kwargs', TEName.create('kwargs')],
                            ])
                        ),
                        TSReturn.create(TEConst.genNone())
                    ),
                    selfName
                ),
                className
            );
        } else {
            initBody = TSLet.create(
                '__class__',
                TSLet.create(
                    '__self__',
                    TSSeq.create(this.visitArray(func.suite.statements), TSReturn.create(TEConst.genNone())),
                    selfName
                ),
                className
            );
        }

        initBody = localDef ? this._mergeLocalDef(localDef, initBody) : initBody;

        let setStmt: ThStmt;

        if (!func) {
            setStmt = TSAssign.create(
                TEAttr.create(className, '__init__'),
                TELibCall.create(LibCallType.setDefault, [
                    ['$func', funcName],
                    ['$varargsName', TEConst.genStr('args')],
                    ['$kwargsName', TEConst.genStr('kwargs')],
                ]),
                func
            );
        } else if (
            func.parameters.some(
                (param) =>
                    param.category === ParameterCategory.VarArgDictionary ||
                    param.category === ParameterCategory.VarArgList ||
                    param.defaultValue !== undefined
            )
        ) {
            const paramNames: [string, ThExpr][] = [['$func', funcName]];

            let keyOnlyNum = -1;
            func.parameters.forEach((param) => {
                const paramName = param.name;
                if (paramName) {
                    if (param.category === ParameterCategory.VarArgList) {
                        paramNames.push(['$varargsName', TEConst.genStr(paramName.value)]);
                    } else if (param.category === ParameterCategory.VarArgDictionary) {
                        paramNames.push(['$kwargsName', TEConst.genStr(paramName.value)]);
                    } else if (param.defaultValue !== undefined) {
                        paramNames.push([paramName.value, this.visitExprNode(param.defaultValue)]);
                    }
                }

                if (param.category === ParameterCategory.VarArgList) keyOnlyNum = 0;
                else if (param.category !== ParameterCategory.VarArgDictionary && keyOnlyNum >= 0) keyOnlyNum += 1;
            });

            if (keyOnlyNum > 0) paramNames.push(['$keyOnlyNum', TEConst.genInt(keyOnlyNum)]);

            setStmt = TSAssign.create(
                TEAttr.create(className, '__init__'),
                TELibCall.create(LibCallType.setDefault, paramNames),
                func
            );
        } else {
            setStmt = TSAssign.create(TEAttr.create(className, '__init__'), funcName, func);
        }

        return TSFunDef.create(funcName.ident, params, initBody, setStmt);
    }
    private _genClassNew(node: ClassNode, hasCall: boolean): ThStmt {
        const className = TEName.create(node.name.value, node.name);
        const funcName = TEName.create(`${node.name.value}$__new__`);
        const selfName = TEName.create(`${node.name.value}$$self`);

        // assign self.$addr to get address of object from object itself
        const defaultAttr: ThStmt[] = [TSAssign.create(TEAttr.create(selfName, '$addr'), selfName)];

        if (hasCall) {
            defaultAttr.push(
                TSFunDef.create(
                    `${node.name.value}$self$__call__`,
                    ['args', 'kwargs'],
                    TSReturn.create(
                        TELibCall.create(LibCallType.callKV, [
                            ['$func', TEAttr.create(className, 'self$call')],
                            ['', selfName],
                            ['$varargs', TEName.create('args')],
                            ['$kwargs', TEName.create('kwargs')],
                        ])
                    ),
                    TSAssign.create(
                        TEAttr.create(selfName, '__call__'),
                        TELibCall.create(LibCallType.setDefault, [
                            ['$func', TEName.create(`${node.name.value}$self$__call__`)],
                            ['$varargsName', TEConst.genStr('args')],
                            ['$kwargsName', TEConst.genStr('kwargs')],
                        ])
                    )
                )
            );
        }

        const newBody = TSLet.create(
            '__class__',
            TSLet.create(
                selfName.ident,
                this._mergeStmt([...defaultAttr, TSReturn.create(selfName)]),
                TECall.create(
                    TEAttr.create(
                        TELibCall.create(LibCallType.super, [
                            ['baseClass', TEName.create('__class__')],
                            ['self', TEConst.genNone()],
                        ]),
                        '__new__'
                    ),
                    [className]
                )
            ),
            className
        );

        return TSFunDef.create(
            funcName.ident,
            ['cls'],
            newBody,
            TSAssign.create(TEAttr.create(className, '__new__'), funcName)
        );
    }
    private _genClassCall(node: ClassNode, initFunc?: FunctionNode): ThStmt {
        const className = TEName.create(node.name.value, node.name);
        const funcName = TEName.create(`${node.name.value}$__call__`);
        const selfName = TEName.create(`${node.name.value}$$self`);

        const inheritParams =
            initFunc &&
            !initFunc.parameters.some((p) => p.defaultValue !== undefined || p.category !== ParameterCategory.Simple);
        let params = inheritParams ? initFunc!.parameters.slice(1).map((p) => p.name!.value) : [];

        let initCall: ThExpr;
        if (!inheritParams) {
            initCall = TELibCall.create(LibCallType.callKV, [
                ['$func', TEAttr.create(className, '__init__')],
                ['', selfName],
                ['$varargs', TEName.create('args')],
                ['$kwargs', TEName.create('kwargs')],
            ]);
        } else {
            initCall = TECall.create(TEAttr.create(className, '__init__'), [
                selfName,
                ...params.map((p) => TEName.create(p)),
            ]);
        }

        const callBody = TSLet.create(
            selfName.ident,
            TSSeq.create(
                TSAssign.create(TEAttr.create(selfName, '__mro__'), TEAttr.create(className, '__mro__')),
                TSSeq.create(TSExpr.create(initCall), TSReturn.create(selfName))
            ),
            TECall.create(TEAttr.create(className, '__new__'), [className])
        );

        let callFunc: ThExpr = funcName;
        if (!inheritParams) {
            callFunc = TELibCall.create(LibCallType.setDefault, [
                ['$func', funcName],
                ['$varargsName', TEConst.genStr('args')],
                ['$kwargsName', TEConst.genStr('kwargs')],
            ]);
            params = ['args', 'kwargs'];
        }

        return TSFunDef.create(
            funcName.ident,
            params,
            callBody,
            TSAssign.create(TEAttr.create(className, '__call__'), callFunc)
        );
    }

    visitWith(node: WithNode): ThStmt {
        // TODO: item.target = item.expression; item.target.__enter__(); statements; item.target.__exit__()
        return this._mergeStmt([
            ...node.withItems.map((item) => {
                if (item.target) {
                    return TSAssign.create(
                        this.visitExprNode(item.target) as ThLeftExpr,
                        this.visitExprNode(item.expression),
                        item
                    );
                } else {
                    return TSExpr.create(this.visitExprNode(item.expression));
                }
            }),
            this.visitArray(node.suite.statements),
        ]);
    }

    visitWhile(node: WhileNode): ThStmt {
        // TODO: precise loop condition
        //       currently, loop 300 times and break.
        const bodyStmt = this._mergeStmt([
            TSIf.create(
                this.visitExprNode(node.testExpression),
                this.visitArray(node.whileSuite.statements),
                TSBreak.create()
            ),
        ]);
        return TSForIn.create(this._getImm(), TECall.create(TEName.create('range'), [TEConst.genInt(300)]), bodyStmt);
    }

    visitDel(node: DelNode): ThStmt {
        // TODO: del x[0] (subscription)
        // TODO: assign undef (temporarily, set None)
        const stmts: ThStmt[] = [];
        node.expressions.forEach((del) => {
            if (del.nodeType === ParseNodeType.Name) {
                stmts.push(TSAssign.create(TEName.create(del.value, del), TEConst.genNone()));
            }
        });

        return this._mergeStmt(stmts);
    }

    visitList(node: ListNode): ThExpr {
        const entries = node.entries.map((expr) => this.visitExprNode(expr));
        return TELibCall.create(
            LibCallType.genList,
            entries.map((v, i) => [`param$${i}`, v]),
            node
        );
    }

    visitDict(node: DictionaryNode): ThExpr {
        // TODO: implement it.
        const entries = node.entries
            .map((expr) => {
                switch (expr.nodeType) {
                    case ParseNodeType.DictionaryKeyEntry:
                        return TETuple.create(
                            [this.visitExprNode(expr.keyExpression), this.visitExprNode(expr.valueExpression)],
                            expr.valueExpression
                        );
                    case ParseNodeType.DictionaryExpandEntry:
                        return;
                    case ParseNodeType.ListComprehension:
                        return;
                }
            })
            .filter((v) => v !== undefined) as TETuple[];
        return TELibCall.create(
            LibCallType.genDict,
            entries.map((v, i) => [`param$${i}`, v]),
            node
        );
    }

    visitStatementList(node: StatementListNode): ThStmt {
        return this.visitArray(node.statements);
    }

    visitAssignment(node: AssignmentNode): ThStmt {
        const right = this.visitExprNode(node.rightExpression);

        if (node.leftExpression.nodeType === ParseNodeType.Tuple) {
            return this._assignTuple(node.leftExpression, right, node);
        } else if (node.leftExpression.nodeType === ParseNodeType.List) {
            return this._assignList(node.leftExpression, right, node);
        }

        return TSAssign.create(
            this.visitExprNode(node.leftExpression) as ThLeftExpr,
            this.visitExprNode(node.rightExpression),
            node
        );
    }

    visitAugmentedAssignment(node: AugmentedAssignmentNode): ThStmt {
        const left = this.visitExprNode(node.leftExpression);
        const right = this.visitExprNode(node.rightExpression);
        const leftType = left.etype;

        if (!(leftType === TEType.Name || leftType === TEType.Attr || leftType === TEType.Subscr)) {
            this.fail(node);
        }

        let op = node.operator;
        switch (op) {
            case OperatorType.AddEqual:
                op = OperatorType.Add;
                break;
            case OperatorType.SubtractEqual:
                op = OperatorType.Subtract;
                break;
            case OperatorType.MultiplyEqual:
                op = OperatorType.Multiply;
                break;
            case OperatorType.DivideEqual:
                op = OperatorType.Divide;
                break;
            case OperatorType.FloorDivideEqual:
                op = OperatorType.FloorDivide;
                break;
            case OperatorType.ModEqual:
                op = OperatorType.Mod;
                break;
            default:
                this.fail(node);
        }

        const bop = parseBinOp(op)!;

        return TSAssign.create(left as ThLeftExpr, TEBinOp.create(bop, left, right, node), node);
    }

    private _assignTuple(left: TupleNode, right: ThExpr, node?: AssignmentNode): ThStmt {
        let stmt: ThStmt | undefined;
        const tempVar = TEName.create(this._getImm(), node?.leftExpression);

        left.expressions.forEach((e, i) => {
            let next: ThStmt | undefined;
            if (e.nodeType === ParseNodeType.Name) {
                next = TSAssign.create(TEName.create(e.value, e), TESubscr.create(tempVar, TEConst.genInt(i), e));
            } else if (e.nodeType === ParseNodeType.List) {
                next = this._assignList(e, TESubscr.create(tempVar, TEConst.genInt(i), e));
            } else if (e.nodeType === ParseNodeType.Tuple) {
                next = this._assignTuple(e, TESubscr.create(tempVar, TEConst.genInt(i), e));
            }

            stmt = stmt ? (next ? TSSeq.create(stmt, next) : stmt) : next;
        });

        return TSLet.create(tempVar.ident, stmt!, right, node);
        // return TSLet.create(this._getImm(), stmt!, right, node);
    }

    private _assignList(left: ListNode, right: ThExpr, node?: AssignmentNode): ThStmt {
        let stmt: ThStmt | undefined;
        const tempVar = TEName.create(this._getImm(), node?.leftExpression);

        left.entries.forEach((e, i) => {
            let next: ThStmt | undefined;
            if (e.nodeType === ParseNodeType.Name) {
                next = TSAssign.create(TEName.create(e.value, e), TESubscr.create(tempVar, TEConst.genInt(i), e));
            } else if (e.nodeType === ParseNodeType.List) {
                next = this._assignList(e, TESubscr.create(right, TEConst.genInt(i), e));
            } else if (e.nodeType === ParseNodeType.Tuple) {
                next = this._assignTuple(e, TESubscr.create(right, TEConst.genInt(i), e));
            }

            stmt = stmt ? (next ? TSSeq.create(stmt, next) : stmt) : next;
        });

        return TSLet.create(tempVar.ident, stmt!, right, node);
    }

    visitBinaryOperation(node: BinaryOperationNode): ThExpr {
        let op = node.operator;
        let leftNode = node.leftExpression;
        let rightNode = node.rightExpression;

        // flip gt(e) to lt(e)
        if (op === OperatorType.GreaterThan || op === OperatorType.LessThanOrEqual) {
            leftNode = node.rightExpression;
            rightNode = node.leftExpression;
            if (op === OperatorType.GreaterThan) {
                op = OperatorType.LessThan;
            } else {
                op = OperatorType.LessThanOrEqual;
            }
        }

        const bop = parseBinOp(op);
        if (bop === undefined) {
            this.fail(node);
        }

        const left = this.visitExprNode(leftNode);
        const right = this.visitExprNode(rightNode);

        if (bop === TEBopType.IsNot) {
            return TEUnaryOp.create(TEUopType.Not, TEBinOp.create(TEBopType.Is, left, right, node), node);
        } else if (bop === TEBopType.NotIn) {
            return TEUnaryOp.create(TEUopType.Not, TEBinOp.create(TEBopType.In, left, right, node), node);
        }

        return TEBinOp.create(bop, left, right, node);
    }

    visitTernary(node: TernaryNode): ThExpr {
        // x ? y : z => (x and y) or z  (from Lua's trick)
        const cond = this.visitExprNode(node.testExpression);
        const left = this.visitExprNode(node.ifExpression);
        const right = this.visitExprNode(node.elseExpression);
        return TEBinOp.create(TEBopType.Or, TEBinOp.create(TEBopType.And, cond, left, node), right, node);
    }

    visitBreak(node: BreakNode): ThStmt {
        return TSBreak.create(node);
    }

    visitCall(node: CallNode): ThExpr {
        const args = node.arguments.map((arg) => this.visitExprNode(arg.valueExpression));
        const left = this.visitExprNode(node.leftExpression);

        // resolve explicit LibCall.
        if (left.etype === TEType.Attr) {
            const leftPath = getFullAttrPath(left);
            if (leftPath && leftPath[0] === 'LibCall') {
                if (leftPath.length === 2) {
                    if (leftPath[1] === 'getAttr' && args.length === 4) {
                        return TELibCall.create(
                            LibCallType.getAttr,
                            [
                                ['name', args[0]],
                                ['self', args[1]],
                                ['baseClass', args[2]],
                                ['bind', args[3]],
                            ],
                            node
                        );
                    } else if (leftPath[1] === 'DEBUG') {
                        return TELibCall.create(
                            LibCallType.DEBUG,
                            args.map((arg) => ['', arg]),
                            node
                        );
                    } else if (leftPath[1] === 'objectClass') {
                        return TELibCall.create(LibCallType.objectClass, [], node);
                    }
                }

                return TELibCall.create(
                    LibCallType.explicit,
                    [
                        ['$func', TEConst.genStr(leftPath.splice(1).join('.'))],
                        ...args.map((expr) => ['', expr] as [string, ThExpr]),
                    ],
                    node
                );
            }
        }

        if (left.etype === TEType.Name && left.ident === 'super') {
            if (args.length >= 2) {
                return TELibCall.create(
                    LibCallType.super,
                    [
                        ['baseClass', args[0]],
                        ['self', args[1]],
                    ],
                    node
                );
            } else if (args.length === 1) {
                return TELibCall.create(
                    LibCallType.super,
                    [
                        ['baseClass', args[0]],
                        ['self', TEName.create('__self__')],
                    ],
                    node
                );
            } else {
                return TELibCall.create(
                    LibCallType.super,
                    [
                        ['baseClass', TEName.create('__class__')],
                        ['self', TEName.create('__self__')],
                    ],
                    node
                );
            }
        } else if (
            node.arguments.some(
                (arg) =>
                    arg.name !== undefined ||
                    arg.argumentCategory === ArgumentCategory.UnpackedDictionary ||
                    arg.argumentCategory === ArgumentCategory.UnpackedList
            )
        ) {
            const kwargs: [string, ThExpr][] = [];
            const posArgs: [string, ThExpr][] = [];
            node.arguments.forEach((arg) => {
                if (arg.name) {
                    kwargs.push([arg.name.value, this.visitExprNode(arg.valueExpression)]);
                } else if (arg.argumentCategory === ArgumentCategory.UnpackedDictionary) {
                    kwargs.push(['$kwargs', this.visitExprNode(arg.valueExpression)]);
                } else if (arg.argumentCategory === ArgumentCategory.UnpackedList) {
                    posArgs.push(['$varargs', this.visitExprNode(arg.valueExpression)]);
                } else {
                    posArgs.push(['', this.visitExprNode(arg.valueExpression)]);
                }
            });

            return TELibCall.create(LibCallType.callKV, [['$func', left], ...posArgs, ...kwargs], node);
        }

        return TECall.create(left, args, node);
    }

    visitContinue(node: ContinueNode): ThStmt {
        return TSContinue.create(node);
    }

    visitConstant(node: ConstantNode): ThExpr {
        switch (node.constType) {
            case KeywordType.True:
                return TEConst.create(TEConstType.Bool, true, node);
            case KeywordType.False:
                return TEConst.create(TEConstType.Bool, false, node);
            case KeywordType.None:
                return TEConst.create(TEConstType.None, undefined, node);
            default:
                this.fail(node);
        }
    }

    visitIf(node: IfNode): ThStmt {
        const expr = this.visitExprNode(node.testExpression);
        const ifStmt = this.visitArray(node.ifSuite.statements);
        const elseSuite = node.elseSuite;

        let elseStmt: ThStmt;
        if (elseSuite) {
            if (elseSuite.nodeType === ParseNodeType.If) {
                elseStmt = this.visitIf(elseSuite);
            } else {
                elseStmt = this.visitArray(elseSuite.statements);
            }
        } else {
            elseStmt = TSPass.get();
        }

        return TSIf.create(expr, ifStmt, elseStmt, node);
    }

    visitIndex(node: IndexNode): ThExpr {
        const items = node.items.items.map((i) => this.visitExprNode(i));
        if (items.length === 0) {
            this.fail(node);
        } else if (items.length >= 2) {
            const tuple = TETuple.create(items, node);
            return TESubscr.create(this.visitExprNode(node.baseExpression), tuple, node);
        } else {
            return TESubscr.create(this.visitExprNode(node.baseExpression), items[0], node);
        }
    }

    visitFor(node: ForNode): ThStmt {
        const idx = extractIds(node.targetExpression);
        if (!idx) {
            this.fail(node);
        }
        const iter = this.visitExprNode(node.iterableExpression);
        let body = this.visitArray(node.forSuite.statements);
        let idxName: string;

        if (idx.length === 1) {
            idxName = idx[0];
        } else {
            idxName = this._getImm();
        }

        if (idx.length > 1) {
            if (node.targetExpression.nodeType === ParseNodeType.Tuple) {
                body = TSSeq.create(
                    this._assignTuple(node.targetExpression, TEName.create(idxName, node.targetExpression)),
                    body
                );
            } else if (node.targetExpression.nodeType === ParseNodeType.List) {
                body = TSSeq.create(
                    this._assignList(node.targetExpression, TEName.create(idxName, node.targetExpression)),
                    body
                );
            }

            let mainFor: ThStmt = TSForIn.create(idxName, iter, body, node);

            for (const name of idx) {
                mainFor = TSLet.create(name, mainFor);
            }
            return mainFor;
        }

        return TSForIn.create(idxName, iter, body, node);
    }

    visitFunction(node: FunctionNode): [string, string[], ThStmt] {
        const name = node.name.value;
        const params = extractIds(node.parameters);
        const localDef = extractLocalDef(
            node.suite.statements,
            node.parameters.map((p) => p.name?.value)
        );

        if (!params) {
            this.fail(node);
        }
        const body = this.visitArray(node.suite.statements);
        const stmt = this._mergeLocalDef(localDef, TSSeq.create(body, TSReturn.create(TEConst.genNone())));

        return [name, params, stmt];
    }

    visitName(node: NameNode): ThExpr {
        return TEName.create(node.value);
    }

    visitNumber(node: NumberNode): ThExpr {
        if (node.isInteger) {
            return TEConst.create(TEConstType.Int, node.value, node);
        } else {
            return TEConst.create(TEConstType.Float, node.value, node);
        }
    }

    visitMemberAccess(node: MemberAccessNode): ThExpr {
        return TEAttr.create(this.visitExprNode(node.leftExpression), node.memberName.value, node);
    }

    visitPass(node: PassNode): ThStmt {
        return TSPass.get(node);
    }

    visitReturn(node: ReturnNode): ThStmt {
        const expr = node.returnExpression
            ? this.visitExprNode(node.returnExpression)
            : TEConst.create(TEConstType.None, undefined);
        return TSReturn.create(expr, node);
    }

    visitString(node: StringNode): ThExpr {
        return TEConst.create(TEConstType.String, node.value, node);
    }

    visitStringList(node: StringListNode): ThExpr {
        return TEConst.create(TEConstType.String, node.strings.map((str) => str.value).join(''), node);
    }

    visitTuple(node: TupleNode): ThExpr {
        return TETuple.create(
            node.expressions.map((e) => this.visitExprNode(e)),
            node
        );
    }

    visitUnaryOperation(node: UnaryOperationNode): ThExpr {
        const uop = parseUnaryOp(node.operator);
        if (uop === undefined) {
            this.fail(node);
        }

        return TEUnaryOp.create(uop, this.visitExprNode(node.expression), node);
    }

    visitAssert(node: AssertNode): ThStmt {
        if (PyteaService.ignoreAssert()) {
            return TSPass.get();
        }

        // if node.testExpression: pass
        // else: raise AssertionError(node.exceptionExpression)
        const error = TECall.create(
            TEName.create('AssertionError', node.testExpression),
            node.exceptionExpression ? [this.visitExprNode(node.exceptionExpression)] : [],
            node.testExpression
        );
        return TSIf.create(
            this.visitExprNode(node.testExpression),
            TSPass.get(),
            TSExpr.create(TELibCall.create(LibCallType.raise, [['value', error]], node)),
            node
        );
    }

    visitRaise(node: RaiseNode): ThStmt {
        // TODO: try / catch / raise context
        // if valueExpression is not set, currently, jsut raise RuntimeError
        // also ignores traceback
        const error = node.typeExpression
            ? this.visitExprNode(node.typeExpression)
            : TECall.create(TEName.create('RuntimeError'), []);
        return TSExpr.create(TELibCall.create(LibCallType.raise, [['value', error]], node));
    }

    visitSlice(node: SliceNode): ThExpr {
        return TECall.create(
            TEName.create('slice'),
            [
                node.startValue ? this.visitExprNode(node.startValue) : TEConst.create(TEConstType.None, undefined),
                node.endValue ? this.visitExprNode(node.endValue) : TEConst.create(TEConstType.None, undefined),
                node.stepValue ? this.visitExprNode(node.stepValue) : TEConst.create(TEConstType.None, undefined),
            ],
            node
        );
    }

    visitEllipsis(node: EllipsisNode): ThExpr {
        return TEName.create('Ellipsis', node);
    }

    visitNode(node: ParseNode): ThStmt | ThExpr {
        switch (node.nodeType) {
            case ParseNodeType.Assert:
            case ParseNodeType.Assignment:
            case ParseNodeType.AugmentedAssignment:
            case ParseNodeType.Break:
            case ParseNodeType.Continue:
            case ParseNodeType.If:
            case ParseNodeType.For:
            case ParseNodeType.Module:
            case ParseNodeType.Pass:
            case ParseNodeType.Raise:
            case ParseNodeType.Return:
            case ParseNodeType.StatementList:
            case ParseNodeType.Nonlocal:
            case ParseNodeType.Global:
            case ParseNodeType.Import:
            case ParseNodeType.ImportAs:
            case ParseNodeType.ImportFrom:
            case ParseNodeType.Class:
            case ParseNodeType.With:
            case ParseNodeType.While:
            case ParseNodeType.Del:
                return this.visitStmtNode(node);
            case ParseNodeType.BinaryOperation:
            case ParseNodeType.UnaryOperation:
            case ParseNodeType.Call:
            case ParseNodeType.Constant:
            case ParseNodeType.Index:
            case ParseNodeType.MemberAccess:
            case ParseNodeType.Name:
            case ParseNodeType.Number:
            case ParseNodeType.String:
            case ParseNodeType.StringList:
            case ParseNodeType.Tuple:
            case ParseNodeType.List:
            case ParseNodeType.Dictionary:
            case ParseNodeType.Slice:
            case ParseNodeType.Ellipsis:
                return this.visitExprNode(node as ExpressionNode);
            default:
                return TSPass.get(node);
        }
    }

    visitStmtNode(node: ParseNode): ThStmt {
        switch (node.nodeType) {
            case ParseNodeType.Assert:
                return this.visitAssert(node);
            case ParseNodeType.Assignment:
                return this.visitAssignment(node);
            case ParseNodeType.AugmentedAssignment:
                return this.visitAugmentedAssignment(node);
            case ParseNodeType.Break:
                return this.visitBreak(node);
            case ParseNodeType.Continue:
                return this.visitContinue(node);
            case ParseNodeType.If:
                return this.visitIf(node);
            case ParseNodeType.For:
                return this.visitFor(node);
            case ParseNodeType.Module:
                return this.visitModule(node);
            case ParseNodeType.Pass:
                return this.visitPass(node);
            case ParseNodeType.Raise:
                return this.visitRaise(node);
            case ParseNodeType.Return:
                return this.visitReturn(node);
            case ParseNodeType.StatementList:
                return this.visitStatementList(node);
            case ParseNodeType.Nonlocal:
                return this.visitNonlocal(node);
            case ParseNodeType.Global:
                return this.visitGlobal(node);
            case ParseNodeType.Import:
                return this.visitImport(node);
            case ParseNodeType.ImportAs:
                return this.visitImportAs(node);
            case ParseNodeType.ImportFrom:
                return this.visitImportFrom(node);
            case ParseNodeType.Class:
                return this.visitClass(node);
            case ParseNodeType.With:
                return this.visitWith(node);
            case ParseNodeType.While:
                return this.visitWhile(node);
            case ParseNodeType.Del:
                return this.visitDel(node);
            default:
                return TSPass.get(node);
        }
    }

    visitExprNode(node: ExpressionNode): ThExpr {
        switch (node.nodeType) {
            case ParseNodeType.BinaryOperation:
                return this.visitBinaryOperation(node);
            case ParseNodeType.UnaryOperation:
                return this.visitUnaryOperation(node);
            case ParseNodeType.Ternary:
                return this.visitTernary(node);
            case ParseNodeType.Call:
                return this.visitCall(node);
            case ParseNodeType.Constant:
                return this.visitConstant(node);
            case ParseNodeType.Index:
                return this.visitIndex(node);
            case ParseNodeType.MemberAccess:
                return this.visitMemberAccess(node);
            case ParseNodeType.Name:
                return this.visitName(node);
            case ParseNodeType.Number:
                return this.visitNumber(node);
            case ParseNodeType.String:
                return this.visitString(node);
            case ParseNodeType.StringList:
                return this.visitStringList(node);
            case ParseNodeType.Tuple:
                return this.visitTuple(node);
            case ParseNodeType.List:
                return this.visitList(node);
            case ParseNodeType.Dictionary:
                return this.visitDict(node);
            case ParseNodeType.Slice:
                return this.visitSlice(node);
            case ParseNodeType.Ellipsis:
                return this.visitEllipsis(node);
            default:
                return this.fail(node);
        }
    }

    fail(node: ParseNode): never {
        throw 'invalid node for Python script: ' + inspect(node);
    }

    private _mergeLocalDef(localDef: Set<string>, baseStmt: ThStmt): ThStmt {
        let stmt = baseStmt;
        localDef.forEach((name) => {
            stmt = TSLet.create(name, stmt);
        });
        return stmt;
    }

    private _mergeStmt(stmts: ThStmt[]): ThStmt {
        if (stmts.length === 0) {
            return TSPass.get();
        } else {
            const copied = [...stmts];
            let stmt = copied.pop()!;
            copied.reverse().forEach((s) => {
                stmt = TSSeq.create(s, stmt);
            });
            return stmt;
        }
    }

    private _getImm(): string {
        return `$Imm${++this._immId}`;
    }
}
