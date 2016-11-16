/*
 * BSD 3-Clause License
 *
 * Copyright (c) 2015, Nicolas Riesco and others as credited in the AUTHORS file
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 * this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 * this list of conditions and the following disclaimer in the documentation
 * and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 * may be used to endorse or promote products derived from this software without
 * specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 *
 */

/** @module nel
 *
 * @description Module `nel` provides a Javascript REPL session. A Javascript
 * session can be used to run Javascript code within `Node.js`, pass the result
 * to a callback function and even capture its `stdout` and `stderr` streams.
 *
 */
module.exports = {
    Session: Session,
};

var console = require("console");
var fs = require("fs");
var path = require("path");
var fork = require("child_process").fork;

var doc = require("./mdn.js"); // Documentation for Javascript builtins


// Setup logging helpers
var log;
var dontLog = function dontLog() {};
var doLog = function doLog() {
    process.stderr.write("NEL: ");
    console.error.apply(this, arguments);
};

if (process.env.DEBUG) {
    global.DEBUG = true;

    try {
        doLog = require("debug")("NEL:");
    } catch (err) {}
}

log = global.DEBUG ? doLog : dontLog;


// File paths
var paths = {
    node: process.argv[0],
    thisFile: fs.realpathSync(module.filename),
};
paths.thisFolder = path.dirname(paths.thisFile);
paths.client = paths.thisFile;
paths.server = path.join(paths.thisFolder, "nel_server.js");


/**
 * Javascript session configuration.
 *
 * @typedef Config
 *
 * @property {string}  [cwd]        Session current working directory
 * @property {module:nel~Transpiler}
 *                     [transpile]  Function that transpiles the request code
 *                                  into Javascript that can be run by the
 *                                  Node.js session.
 *
 * @see {@link module:nel~Session}
 */


/**
 * Function that transpiles the request code into Javascript that can be run by
 * the Node.js session.
 *
 * @typedef Transpiler
 *
 * @type    {function}
 * @param   {string}  code  Request code
 * @returns {string}        Transpiled code
 *
 * @see {@link module:nel~Config}
 */


/**
 * @class
 * @classdesc Implements a Node.js session
 * @param {module:nel~Config} [nelConfig] Session configuration.
 */
function Session(nelConfig) {
    nelConfig = nelConfig || {};

    /**
     * Function that transpiles the request code into Javascript that can be run
     * by the Node.js session (null/undefined if no transpilation is needed).
     * @member {?module:nel~Transpiler}
     */
    this.transpile = nelConfig.transpile;

    /**
     * Queue of tasks to be run
     * @member {module:nel~Task[]}
     * @private
     */
    this._tasks = [];

    /**
     * Task currently being run (null if the last running task has finished)
     * @member {module:nel~Task}
     * @private
     */
    this._currentTask = null;

    /**
     * Table of execution contexts
     * (execution contexts are created to allow running multiple execution
     * requests asynchronously)
     * @member {Object.<number, module:nel~Task>}
     * @private
     */
    this._contextTable = {};

    /**
     * Last execution context id (0 if none have been created)
     * @member {number}
     * @private
     */
    this._lastContextId = 0;

    /**
     * Last run task (null if none have been run)
     * @member {module:nel~Task}
     * @private
     */
    this._lastTask = null;

    /**
     * Session configuration
     * @member {module:nel~Config}
     * @private
     */
    this._config = {
        cwd: nelConfig.cwd,
        stdio: global.DEBUG ?
            [process.stdin, process.stdout, process.stderr, "ipc"] :
            ["ignore", "ignore", "ignore", "ipc"],
    };

    /**
     * Server that runs the code requests for this session
     * @member {module:child_process~ChildProcess}
     * @private
     */
    this._server = fork(paths.server, this._config);

    /**
     * True after calling {@link module:nel~Session.kill}, otherwise false
     * @member {Boolean}
     * @private
     */
    this._killed = false;

    this._server.on("message", Session.prototype._onMessage.bind(this));
}

/**
 * Path to node executable
 * @member {String}
 * @private
 */
Session._command = paths.node;

/**
 * Arguments passed onto the node executable
 * @member {String[]}
 * @private
 */
Session._args = ["--eval", fs.readFileSync(paths.server)]; // --eval workaround

/**
 * Combination of a piece of code to be run within a session and all the
 * associated callbacks.
 * @see {@link module:nel~Session#_run}
 *
 * @typedef Task
 *
 * @property {string}                 action      Type of task:
 *                                                "run" to evaluate a piece of
 *                                                code and return the result;
 *                                                "getAllPropertyNames" to
 *                                                evaluate a piece of code and
 *                                                return all the property names
 *                                                of the result;
 *                                                "inspect" to inspect an object
 *                                                and return information such as
 *                                                the list of constructors,
 *                                                string representation,
 *                                                length...
 * @property {string}                 code        Code to evaluate
 * @property {module:nel~OnSuccessCB} [onSuccess] Called if no errors occurred
 * @property {module:nel~OnErrorCB}   [onError]   Called if an error occurred
 * @property {module:nel~BeforeRunCB} [beforeRun] Called before running the code
 * @property {module:nel~AfterRunCB}  [afterRun]  Called after running the code
 * @property {module:nel~OnStdioCB}   [onStdout]  Called if process.stdout data
 * @property {module:nel~OnStdioCB}   [onStderr]  Called if process.stderr data
 *
 * @private
 */

/**
 * Callback invoked with the data written on `process.stdout` or
 * `process.stderr` after a request to the server.
 * @see {@link module:nel~Task}
 *
 * @callback OnStdioCB
 * @param {string} data
 */

/**
 * Callback invoked before running a task
 * @see {@link module:nel~Task}
 *
 * @callback BeforeRunCB
 */

/**
 * Callback invoked after running a task (regardless of success or failure)
 * @see {@link module:nel~Task}
 *
 * @callback AfterRunCB
 */

/**
 * Callback invoked with the error obtained while running a task
 * @see {@link module:nel~Task}
 *
 * @callback OnErrorCB
 * @param {module:nel~ErrorResult} error
 */

/**
 * Callback invoked with the result of a task
 * @see {@link module:nel~Task}
 *
 * @typedef OnSuccessCB {
 *     module:nel~OnExecutionSuccessCB |
 *     module:nel~OnCompletionSuccessCB |
 *     module:nel~OnInspectionSuccessCB |
 *     module:nel~OnNameListSuccessCB
 * }
 */

/**
 * Callback run with the result of an execution request
 * @see {@link module:nel~Session#execute}
 *
 * @callback OnExecutionSuccessCB
 * @param {module:nel~ExecutionMessage} result  MIME representations
 */

/**
 * Callback run with the result of an completion request
 * @see {@link module:nel~Session#complete}
 *
 * @callback OnCompletionSuccessCB
 * @param {module:nel~CompletionMessage} result  Completion request results
 */

/**
 * Callback run with the result of an inspection request
 * @see {@link module:nel~Session#inspect}
 *
 * @callback OnInspectionSuccessCB
 * @param {module:nel~InspectionMessage} result Inspection request result
 */

/**
 * Callback run with the list of all the property names
 *
 * @callback OnNameListSuccessCB
 * @param {module:nel~NameListMessage} result  List of all the property names
 *
 * @private
 */

/**
 * Callback run after the session server has been killed
 * @see {@link module:nel~Session#kill}
 *
 * @callback KillCB
 * @param {Number} [code]    Exit code from session server if exited normally
 * @param {String} [signal]  Signal passed to kill the session server
 */

/**
 * Callback run after the session server has been restarted
 * @see {@link module:nel~Session#restart}
 *
 * @callback RestartCB
 * @param {Number} [code]    Exit code from old session if exited normally
 * @param {String} [signal]  Signal passed to kill the old session
 */

/**
 * Message received from the session server
 *
 * @typedef Message {
 *     module:nel~LogMessage |
 *     module:nel~StdoutMessage |
 *     module:nel~StderrMessage |
 *     module:nel~ErrorMessage |
 *     module:nel~SuccessMessage
 * }
 */

/**
 * Log message received from the session server
 *
 * @typedef LogMessage
 *
 * @property {string}   log     Message for logging purposes
 *
 * @private
 */

/**
 * Stdout message received from the session server
 *
 * @typedef StdoutMessage
 *
 * @property {number}   id      Execution context id
 * @property {string}   stdout  Data written on the session stdout
 *
 * @private
 */

/**
 * Stderr message received from the session server
 *
 * @typedef StderrMessage
 *
 * @property {number}   id      Execution context id
 * @property {string}   stderr  Data written on the session stderr
 *
 * @private
 */

/**
 * Error thrown when running a task within a session
 * @see {@link module:nel~Session#execute}, {@link module:nel~Session#complete},
 * and {@link module:nel~Session#inspect}
 *
 * @typedef ErrorMessage
 *
 * @property {number}   [id]             Execution context id
 *                                       (deleted before passing the message
 *                                       onto the API user)
 * @property {boolean}  [end]            Flag to terminate the execution context
 * @property            error
 * @property {String}   error.ename      Error name
 * @property {String}   error.evalue     Error value
 * @property {String[]} error.traceback  Error traceback
 */

/**
 * Request result
 * @see {@link module:nel~Session#execute}, {@link module:nel~Session#complete},
 * and {@link module:nel~Session#inspect}
 *
 * @typedef SuccessMessage {
 *     module:nel~ExecutionMessage |
 *     module:nel~CompletionMessage |
 *     module:nel~InspectionMessage |
 *     module:nel~NameListMessage
 * }
 */

/**
 * MIME representations of the result of an execution request
 * @see {@link module:nel~Session#execute}
 *
 * @typedef ExecutionMessage
 *
 * @property {number}  [id]    Execution context id
 *                             (deleted before the message reaches the API user)
 * @property {boolean} [end]   Flag to terminate the execution context
 * @property           mime
 * @property {string}  [mime."text/plain"]    Result in plain text
 * @property {string}  [mime."text/html"]     Result in HTML format
 * @property {string}  [mime."image/svg+xml"] Result in SVG format
 * @property {string}  [mime."image/png"]     Result as PNG in a base64 string
 * @property {string}  [mime."image/jpeg"]    Result as JPEG in a base64 string
 */

/**
 * Results of a completion request
 * @see {@link module:nel~Session#complete}
 *
 * @typedef CompletionMessage
 *
 * @property {number}   [id]                    Execution context id
 *                                              (deleted before passing the
 *                                              message onto the API user)
 * @property            completion
 * @property {String[]} completion.list         Array of completion matches
 * @property {String}   completion.code         Javascript code to be completed
 * @property {Integer}  completion.cursorPos    Cursor position within
 *                                              `completion.code`
 * @property {String}   completion.matchedText  Text within `completion.code`
 *                                              that has been matched
 * @property {Integer}  completion.cursorStart  Position of the start of
 *                                              `completion.matchedText` within
 *                                              `completion.code`
 * @property {Integer}  completion.cursorEnd    Position of the end of
 *                                              `completion.matchedText` within
 *                                              `completion.code`
 */

/**
 * Results of an inspection request
 * @see {@link module:nel~Session#inspect}
 *
 * @typedef InspectionMessage
 *
 * @property {number}   [id]                    Execution context id
 *                                              (deleted before passing the
 *                                              message onto the API user)
 * @property            inspection
 * @property {String}   inspection.code         Javascript code to be inspected
 * @property {Integer}  inspection.cursorPos    Cursor position within
 *                                              `inspection.code`.
 * @property {String}   inspection.matchedText  Text within `inspection.code`
 *                                              that has been matched as an
 *                                              expression.
 * @property {String}   inspection.string       String representation
 * @property {String}   inspection.type         Javascript type
 * @property {String[]} [inspection.constructorList]
 *                                              List of constructors (not
 *                                              defined for `null` or
 *                                              `undefined`).
 * @property {Integer}  [inspection.length]     Length property (if present)
 *
 * @property            [doc]                   Defined only for calls to {@link
 *                                              module:nel~inspect} that succeed
 *                                              to find documentation for a
 *                                              Javascript expression
 * @property {String}   doc.description         Description
 * @property {String}   [doc.usage]             Usage
 * @property {String}   doc.url                 Link to the documentation source
 */

/**
 * Results of an "getAllPropertyNames" action
 * @see {@link module:nel~Task}
 *
 * @typedef NameListMessage
 *
 * @property {number}   [id]   Execution context id
 *                             (deleted before the message reaches the API user)
 * @property {String[]} names  List of all property names
 *
 * @private
 */

/**
 * Callback to handle messages from the session server
 *
 * @param {module:nel~Message} message
 * @private
 */
Session.prototype._onMessage = function(message) {
    log("SESSION: MESSAGE:", message);

    var contextId = message.id;
    delete message.id;

    var endMessage = message.end;
    delete message.end;

    // Handle message.log
    if (message.log) {
        log(message.log);
        return;
    }

    // Get execution context
    // (if context is missing, default to using the last context)
    var task = this._contextTable[contextId];

    if (!task) {
        log(
            "SESSION: MESSAGE: Missing context, using last context, id =",
            contextId
        );

        task = this._lastTask;
        if (!task) {
            log("SESSION: MESSAGE: DROPPED: There is no last context");
            return;
        }
    }

    // Handle message.stdout
    if (message.stdout) {
        if (task.onStdout) {
            task.onStdout(message.stdout);
        } else {
            log("SESSION: MESSAGE: Missing stderr callback");
        }
        return;
    }

    // Handle message.stderr
    if (message.stderr) {
        if (task.onStderr) {
            task.onStderr(message.stderr);
        } else {
            log("SESSION: MESSAGE: Missing stderr callback");
        }
        return;
    }

    // Handle error and success messages
    if (message.hasOwnProperty("error")) {
        if (task.onError) {
            task.onError(message);
        } else {
            log("SESSION: MESSAGE: Missing onError callback");
        }
    } else {
        if (task.onSuccess) {
            task.onSuccess(message);
        } else {
            log("SESSION: MESSAGE: Missing onSuccess callback");
        }
    }

    // Handle message.end
    if (endMessage) {
        if (task) {
            log("SESSION: MESSAGE: END: id =", contextId);

            delete this._contextTable[contextId];

            if (task.afterRun) {
                task.afterRun();
            }
        } else {
            log("SESSION: MESSAGE: END: DROPPED: id =", contextId);
        }
    }

    // If the task for this message is the last running task,
    // proceed to run the next task on the queue.
    if (task && task === this._currentTask) {
        this._currentTask = null;

        if (this._tasks.length > 0) {
            this._runNow(this._tasks.shift());
        }
    }
};

/**
 * Run a task
 *
 * @param {module:nel~Task} task
 * @private
 */
Session.prototype._run = function(task) {
    if (this._killed) {
        return;
    }

    log("SESSION: TASK:", task);

    if (this._currentTask === null) {
        this._runNow(task);
    } else {
        this._runLater(task);
    }
};

/**
 * Run a task now
 *
 * @param {module:nel~Task} task
 * @private
 */
Session.prototype._runNow = function(task) {
    this._currentTask = task;

    this._lastContextId++;
    this._lastTask = this._currentTask;
    this._contextTable[this._lastContextId] = this._lastTask;

    if (this._lastTask.beforeRun) {
        this._lastTask.beforeRun();
    }

    if (this.transpile && this._lastTask.action === "run") {
        try {
            // Adapted from https://github.com/n-riesco/nel/issues/1 by kebot
            var transpiledCode = this.transpile(this._lastTask.code);
            log("transpile: \n", transpiledCode, "\n");
            this._lastTask.code = transpiledCode;
        } catch (error) {
            this._onMessage({
                error: {
                    ename: (error && error.name) ?
                        error.name : typeof error,
                    evalue: (error && error.message) ?
                        error.message : util.inspect(error),
                    traceback: (error && error.stack) ?
                        error.stack.split("\n") : "",
                },
            });
            return;
        }
    }

    this._server.send(
        [this._lastTask.action, this._lastTask.code, this._lastContextId]
    );
};

/**
 * Run a task later
 *
 * @param {module:nel~Task} task
 * @private
 */
Session.prototype._runLater = function(task) {
    this._tasks.push(task);
};

/**
 * Make an execution request
 *
 * @param {String}               code                 Code to execute in session
 * @param                        [callbacks]
 * @param {OnExecutionSuccessCB} [callbacks.onSuccess]
 * @param {OnErrorCB}            [callbacks.onError]
 * @param {BeforeRunCB}          [callbacks.beforeRun]
 * @param {AfterRunCB}           [callbacks.afterRun]
 * @param {OnStdioCB}            [callbacks.onStdout]
 * @param {OnStdioCB}            [callbacks.onStderr]
 */
Session.prototype.execute = function(code, callbacks) {
    log("SESSION: EXECUTE:", code);

    var task = {
        action: "run",
        code: code,
    };

    if (callbacks) {
        if (callbacks.onSuccess) {
            task.onSuccess = callbacks.onSuccess;
        }
        if (callbacks.onError) {
            task.onError = callbacks.onError;
        }
        if (callbacks.beforeRun) {
            task.beforeRun = callbacks.beforeRun;
        }
        if (callbacks.afterRun) {
            task.afterRun = callbacks.afterRun;
        }
        if (callbacks.onStdout) {
            task.onStdout = callbacks.onStdout;
        }
        if (callbacks.onStderr) {
            task.onStderr = callbacks.onStderr;
        }
    }

    this._run(task);
};

/**
 * Complete a Javascript expression
 *
 * @param {String}                code                  Javascript code
 * @param {Number}                cursorPos             Cursor position in code
 * @param                         [callbacks]
 * @param {OnCompletionSuccessCB} [callbacks.onSuccess]
 * @param {OnErrorCB}             [callbacks.onError]
 * @param {BeforeRunCB}           [callbacks.beforeRun]
 * @param {AfterRunCB}            [callbacks.afterRun]
 * @param {OnStdioCB}             [callbacks.onStdout]
 * @param {OnStdioCB}             [callbacks.onStderr]
 */
Session.prototype.complete = function(code, cursorPos, callbacks) {
    var matchList = [];
    var matchedText;
    var cursorStart;
    var cursorEnd;

    var expression = parseExpression(code, cursorPos);
    log("SESSION: COMPLETE: expression", expression);

    if (expression === null) {
        if (callbacks) {
            if (callbacks.beforeRun) {
                callbacks.beforeRun();
            }

            if (callbacks.onSuccess) {
                callbacks.onSuccess({
                    completion: {
                        list: matchList,
                        code: code,
                        cursorPos: cursorPos,
                        matchedText: "",
                        cursorStart: cursorPos,
                        cursorEnd: cursorPos,
                    },
                });
            }

            if (callbacks.afterRun) {
                callbacks.afterRun();
            }
        }

        return;
    }

    var task = {
        action: "getAllPropertyNames",
        code: (expression.scope === "") ? "global" : expression.scope,
    };

    if (callbacks) {
        if (callbacks.onError) {
            task.onError = callbacks.onError;
        }
        if (callbacks.beforeRun) {
            task.beforeRun = callbacks.beforeRun;
        }
        if (callbacks.afterRun) {
            task.afterRun = callbacks.afterRun;
        }
        if (callbacks.onStdout) {
            task.onStdout = callbacks.onStdout;
        }
        if (callbacks.onStderr) {
            task.onStderr = callbacks.onStderr;
        }
    }

    task.onSuccess = function(result) {
        // append list of all property names
        matchList = matchList.concat(result.names);

        // append list of reserved words
        if (expression.scope === "") {
            matchList = matchList.concat(javascriptKeywords);
        }

        // filter matches
        if (expression.selector) {
            matchList = matchList.filter(function(e) {
                return e.lastIndexOf(expression.selector, 0) === 0;
            });
        }

        // append expression.rightOp to each match
        var left = expression.scope + expression.leftOp;
        var right = expression.rightOp;
        if (left || right) {
            matchList = matchList.map(function(e) {
                return left + e + right;
            });
        }

        // find range of text that should be replaced
        if (matchList.length > 0) {
            var shortestMatch = matchList.reduce(function(p, c) {
                return p.length <= c.length ? p : c;
            });

            cursorStart = code.indexOf(expression.matchedText);
            cursorEnd = cursorStart;
            var cl = code.length;
            var ml = shortestMatch.length;
            for (var i = 0; i < ml && cursorEnd < cl; i++, cursorEnd++) {
                if (shortestMatch.charAt(i) !== code.charAt(cursorEnd)) {
                    break;
                }
            }
        } else {
            cursorStart = cursorPos;
            cursorEnd = cursorPos;
        }

        // return completion results to the callback
        matchedText = expression.matchedText;

        if (callbacks && callbacks.onSuccess) {
            callbacks.onSuccess({
                completion: {
                    list: matchList,
                    code: code,
                    cursorPos: cursorPos,
                    matchedText: matchedText,
                    cursorStart: cursorStart,
                    cursorEnd: cursorEnd,
                },
            });
        }
    };

    this._run(task);
};

/**
 * Inspect a Javascript expression
 *
 * @param {String}                code                  Javascript code
 * @param {Number}                cursorPos             Cursor position in code
 * @param                         [callbacks]
 * @param {OnInspectionSuccessCB} [callbacks.onSuccess]
 * @param {OnErrorCB}             [callbacks.onError]
 * @param {BeforeRunCB}           [callbacks.beforeRun]
 * @param {AfterRunCB}            [callbacks.afterRun]
 * @param {OnStdioCB}             [callbacks.onStdout]
 * @param {OnStdioCB}             [callbacks.onStderr]
 */
Session.prototype.inspect = function(code, cursorPos, callbacks) {
    var expression = parseExpression(code, cursorPos);
    log("SESSION: INSPECT: expression:", expression);

    if (expression === null) {
        if (callbacks) {
            if (callbacks.beforeRun) {
                callbacks.beforeRun();
            }

            if (callbacks.onSuccess) {
                callbacks.onSuccess({
                    inspection: {
                        code: code,
                        cursorPos: cursorPos,
                        matchedText: "",
                        string: "",
                        type: ""
                    },
                });
            }

            if (callbacks.afterRun) {
                callbacks.afterRun();
            }
        }

        return;
    }

    var inspectionResult;

    var task = {
        action: "inspect",
        code: expression.matchedText,
    };

    if (callbacks) {
        if (callbacks.onError) {
            task.onError = callbacks.onError;
        }
        if (callbacks.beforeRun) {
            task.beforeRun = callbacks.beforeRun;
        }
        if (callbacks.onStdout) {
            task.onStdout = callbacks.onStdout;
        }
        if (callbacks.onStderr) {
            task.onStderr = callbacks.onStderr;
        }
    }

    task.onSuccess = (function(result) {
        inspectionResult = result;
        inspectionResult.inspection.code = code;
        inspectionResult.inspection.cursorPos = cursorPos;
        inspectionResult.inspection.matchedText = expression.matchedText;

        getDocumentationAndInvokeCallbacks.call(this);
    }).bind(this);

    this._run(task);

    return;

    function getDocumentationAndInvokeCallbacks() {
        var doc;

        // Find documentation associated with the matched text
        if (!expression.scope) {
            doc = getDocumentation(expression.matchedText);
            if (doc) {
                inspectionResult.doc = doc;
            }


            if (callbacks) {
                if (callbacks.onSuccess) {
                    callbacks.onSuccess(inspectionResult);
                }
                if (callbacks.afterRun) {
                    callbacks.afterRun();
                }
            }

            return;
        }

        // Find documentation by searching the chain of constructors
        var task = {
            action: "inspect",
            code: expression.scope,
        };

        if (callbacks) {
            if (callbacks.onError) {
                task.onError = callbacks.onError;
            }
            if (callbacks.afterRun) {
                task.afterRun = callbacks.afterRun;
            }
            if (callbacks.onStdout) {
                task.onStdout = callbacks.onStdout;
            }
            if (callbacks.onStderr) {
                task.onStderr = callbacks.onStderr;
            }
        }

        task.onSuccess = function(result) {
            var constructorList = result.inspection.constructorList;
            if (constructorList) {
                for (var i in constructorList) {
                    var constructorName = constructorList[i];
                    doc = getDocumentation(
                        constructorName +
                        ".prototype." +
                        expression.selector
                    );
                    if (doc) {
                        inspectionResult.doc = doc;
                        break;
                    }
                }
            }

            if (callbacks && callbacks.onSuccess) {
                callbacks.onSuccess(inspectionResult);
            }
        };

        this._run(task);
    }
};

/**
 * Kill session
 *
 * @param {String}              [signal="SIGTERM"] Signal passed to kill the
 *                                                 session server
 * @param {module:nel~KillCB}   [killCB]           Callback run after the
 *                                                 session server has been
 *                                                 killed
 */
Session.prototype.kill = function(signal, killCB) {
    this._killed = true;
    this._server.removeAllListeners();
    this._server.kill(signal || "SIGTERM");
    this._server.on("exit", (function(code, signal) {
        if (killCB) {
            killCB(code, signal);
        }
    }).bind(this));
};

/**
 * Restart session
 *
 * @param {String}               [signal="SIGTERM"] Signal passed to kill the
 *                                                  old session
 * @param {module:nel~RestartCB} [restartCB]        Callback run after restart
 */
Session.prototype.restart = function(signal, restartCB) {
    this.kill(signal || "SIGTERM", (function(code, signal) {
        Session.call(this, this._config);
        if (restartCB) {
            restartCB(code, signal);
        }
    }).bind(this));
};

/**
 * List of Javascript reserved words (ecma-262)
 * @member {RegExp}
 * @private
 */
var javascriptKeywords = [
    // keywords
    "break", "case", "catch", "continue", "debugger", "default",
    "delete", "do", "else", "finally", "for", "function", "if",
    "in", "instanceof", "new", "return", "switch", "this",
    "throw", "try", "typeof", "var", "void", "while", "with",
    // future reserved words
    "class", "const", "enum", "export", "extends", "import",
    "super",
    // future reserved words in strict mode
    "implements", "interface", "let", "package", "private",
    "protected", "public", "static", "yield",
    // null literal
    "null",
    // boolean literals
    "true", "false"
];

/**
 * RegExp for whitespace
 * @member {RegExp}
 * @private
 */
var whitespaceRE = /\s/;

/**
 * RegExp for a simple identifier in Javascript
 * @member {RegExp}
 * @private
 */
var simpleIdentifierRE = /[_$a-zA-Z][_$a-zA-Z0-9]*$/;

/**
 * RegExp for a complex identifier in Javascript
 * @member {RegExp}
 * @private
 */
var complexIdentifierRE = /[_$a-zA-Z][_$a-zA-Z0-9]*(?:[_$a-zA-Z][_$a-zA-Z0-9]*|\.[_$a-zA-Z][_$a-zA-Z0-9]*|\[".*"\]|\['.*'\])*$/;

/**
 * Javascript expression
 *
 * @typedef Expression
 *
 * @property {String} matchedText Matched expression, e.g. `foo["bar`
 * @property {String} scope       Scope of the matched property, e.g. `foo`
 * @property {String} leftOp      Left-hand-side selector operator, e.g. `["`
 * @property {String} selector    Stem of the property being matched, e.g. `bar`
 * @property {String} rightOp     Right-hand-side selector operator, e.g. `"]`
 *
 * @see {@link module:nel~parseExpression}
 * @private
 */

/**
 * Parse a Javascript expression
 *
 * @param {String} code       Javascript code
 * @param {Number} cursorPos  Cursor position within `code`
 *
 * @returns {module:nel~Expression}
 *
 * @todo Parse expressions with parenthesis
 * @private
 */
function parseExpression(code, cursorPos) {
    var expression = code.slice(0, cursorPos);
    if (!expression ||
        whitespaceRE.test(expression[expression.length - 1])) {
        return {
            matchedText: "",
            scope: "",
            leftOp: "",
            selector: "",
            rightOp: "",
        };
    }

    var selector;
    var re = simpleIdentifierRE.exec(expression);
    if (re === null) {
        selector = "";
    } else {
        selector = re[0];
        expression = expression.slice(0, re.index);
    }

    var leftOp;
    var rightOp;
    if (expression[expression.length - 1] === '.') {
        leftOp = ".";
        rightOp = "";
        expression = expression.slice(0, expression.length - 1);
    } else if (
        (expression[expression.length - 2] === '[') &&
        (expression[expression.length - 1] === '"')
    ) {
        leftOp = "[\"";
        rightOp = "\"]";
        expression = expression.slice(0, expression.length - 2);
    } else if (
        (expression[expression.length - 2] === '[') &&
        (expression[expression.length - 1] === '\'')
    ) {
        leftOp = "['";
        rightOp = "']";
        expression = expression.slice(0, expression.length - 2);
    } else {
        return {
            matchedText: code.slice(expression.length, cursorPos),
            scope: "",
            leftOp: "",
            selector: selector,
            rightOp: "",
        };
    }

    var scope;
    re = complexIdentifierRE.exec(expression);
    if (re) {
        scope = re[0];
        return {
            matchedText: code.slice(re.index, cursorPos),
            scope: scope,
            leftOp: leftOp,
            selector: selector,
            rightOp: rightOp,
        };
    } else if (!leftOp) {
        scope = "";
        return {
            matchedText: code.slice(expression.length, cursorPos),
            scope: scope,
            leftOp: leftOp,
            selector: selector,
            rightOp: rightOp,
        };
    }

    // Not implemented
    return null;
}

/**
 * Javascript documentation
 *
 * @typedef Documentation
 *
 * @property {String} description Description
 * @property {String} [usage]     Usage
 * @property {String} url         Link to documentation source
 * @private
 */

/**
 * Get Javascript documentation
 *
 * @param {String} name Javascript name
 *
 * @returns {?module:parser~Documentation}
 * @private
 */
function getDocumentation(name) {
    var builtinName = name;
    if (builtinName in doc) {
        return doc[builtinName];
    }

    builtinName = name.replace(/^[a-zA-Z]+Error./, "Error.");
    if (builtinName in doc) {
        return doc[builtinName];
    }

    builtinName = name.replace(/^[a-zA-Z]+Array./, "TypedArray.");
    if (builtinName in doc) {
        return doc[builtinName];
    }

    return null;
}
