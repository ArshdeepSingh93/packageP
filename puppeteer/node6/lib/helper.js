/**
 * Copyright 2017 Google Inc. All rights reserved.
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
const {TimeoutError} = require('./Errors');

const debugError = require('debug')(`puppeteer:error`);
/** @type {?Map<string, boolean>} */
let apiCoverage = null;

/**
 * @param {!Object} classType
 * @param {string=} publicName
 */
function traceAPICoverage(classType, publicName) {
  if (!apiCoverage)
    return;

  let className = publicName || classType.prototype.constructor.name;
  className = className.substring(0, 1).toLowerCase() + className.substring(1);
  for (const methodName of Reflect.ownKeys(classType.prototype)) {
    const method = Reflect.get(classType.prototype, methodName);
    if (methodName === 'constructor' || typeof methodName !== 'string' || methodName.startsWith('_') || typeof method !== 'function')
      continue;
    apiCoverage.set(`${className}.${methodName}`, false);
    Reflect.set(classType.prototype, methodName, function(...args) {
      apiCoverage.set(`${className}.${methodName}`, true);
      return method.call(this, ...args);
    });
  }

  if (classType.Events) {
    for (const event of Object.values(classType.Events))
      apiCoverage.set(`${className}.emit(${JSON.stringify(event)})`, false);
    const method = Reflect.get(classType.prototype, 'emit');
    Reflect.set(classType.prototype, 'emit', function(event, ...args) {
      if (this.listenerCount(event))
        apiCoverage.set(`${className}.emit(${JSON.stringify(event)})`, true);
      return method.call(this, event, ...args);
    });
  }
}

class Helper {
  /**
   * @param {Function|string} fun
   * @param {!Array<*>} args
   * @return {string}
   */
  static evaluationString(fun, ...args) {
    if (Helper.isString(fun)) {
      assert(args.length === 0, 'Cannot evaluate a string with arguments');
      return /** @type {string} */ (fun);
    }
    return `(${fun})(${args.map(serializeArgument).join(',')})`;

    /**
     * @param {*} arg
     * @return {string}
     */
    function serializeArgument(arg) {
      if (Object.is(arg, undefined))
        return 'undefined';
      return JSON.stringify(arg);
    }
  }

  /**
   * @param {!Protocol.Runtime.ExceptionDetails} exceptionDetails
   * @return {string}
   */
  static getExceptionMessage(exceptionDetails) {
    if (exceptionDetails.exception)
      return exceptionDetails.exception.description || exceptionDetails.exception.value;
    let message = exceptionDetails.text;
    if (exceptionDetails.stackTrace) {
      for (const callframe of exceptionDetails.stackTrace.callFrames) {
        const location = callframe.url + ':' + callframe.lineNumber + ':' + callframe.columnNumber;
        const functionName = callframe.functionName || '<anonymous>';
        message += `\n    at ${functionName} (${location})`;
      }
    }
    return message;
  }

  /**
   * @param {!Protocol.Runtime.RemoteObject} remoteObject
   * @return {*}
   */
  static valueFromRemoteObject(remoteObject) {
    assert(!remoteObject.objectId, 'Cannot extract value when objectId is given');
    if (remoteObject.unserializableValue) {
      switch (remoteObject.unserializableValue) {
        case '-0':
          return -0;
        case 'NaN':
          return NaN;
        case 'Infinity':
          return Infinity;
        case '-Infinity':
          return -Infinity;
        default:
          throw new Error('Unsupported unserializable value: ' + remoteObject.unserializableValue);
      }
    }
    return remoteObject.value;
  }

  /**
   * @param {!Puppeteer.CDPSession} client
   * @param {!Protocol.Runtime.RemoteObject} remoteObject
   */
  static /* async */ releaseObject(client, remoteObject) {return (fn => {
  const gen = fn.call(this);
  return new Promise((resolve, reject) => {
    function step(key, arg) {
      let info, value;
      try {
        info = gen[key](arg);
        value = info.value;
      } catch (error) {
        reject(error);
        return;
      }
      if (info.done) {
        resolve(value);
      } else {
        return Promise.resolve(value).then(
            value => {
              step('next', value);
            },
            err => {
              step('throw', err);
            });
      }
    }
    return step('next');
  });
})(function*(){
    if (!remoteObject.objectId)
      return;
    (yield client.send('Runtime.releaseObject', {objectId: remoteObject.objectId}).catch(error => {
      // Exceptions might happen in case of a page been navigated or closed.
      // Swallow these since they are harmless and we don't leak anything in this case.
      debugError(error);
    }));
  });}

  /**
   * @param {!Object} classType
   * @param {string=} publicName
   */
  static tracePublicAPI(classType, publicName) {
    for (const methodName of Reflect.ownKeys(classType.prototype)) {
      const method = Reflect.get(classType.prototype, methodName);
      if (methodName === 'constructor' || typeof methodName !== 'string' || methodName.startsWith('_') || typeof method !== 'function' || method.constructor.name !== 'AsyncFunction')
        continue;
      Reflect.set(classType.prototype, methodName, function(...args) {
        const syncStack = new Error();
        return method.call(this, ...args).catch(e => {
          const stack = syncStack.stack.substring(syncStack.stack.indexOf('\n') + 1);
          const clientStack = stack.substring(stack.indexOf('\n'));
          if (!e.stack.includes(clientStack))
            e.stack += '\n  -- ASYNC --\n' + stack;
          throw e;
        });
      });
    }

    traceAPICoverage(classType, publicName);
  }

  /**
   * @param {!NodeJS.EventEmitter} emitter
   * @param {(string|symbol)} eventName
   * @param {function(?)} handler
   * @return {{emitter: !NodeJS.EventEmitter, eventName: (string|symbol), handler: function(?)}}
   */
  static addEventListener(emitter, eventName, handler) {
    emitter.on(eventName, handler);
    return { emitter, eventName, handler };
  }

  /**
   * @param {!Array<{emitter: !NodeJS.EventEmitter, eventName: (string|symbol), handler: function(?)}>} listeners
   */
  static removeEventListeners(listeners) {
    for (const listener of listeners)
      listener.emitter.removeListener(listener.eventName, listener.handler);
    listeners.splice(0, listeners.length);
  }

  /**
   * @return {?Map<string, boolean>}
   */
  static publicAPICoverage() {
    return apiCoverage;
  }

  static recordPublicAPICoverage() {
    apiCoverage = new Map();
  }

  /**
   * @param {!Object} obj
   * @return {boolean}
   */
  static isString(obj) {
    return typeof obj === 'string' || obj instanceof String;
  }

  /**
   * @param {!Object} obj
   * @return {boolean}
   */
  static isNumber(obj) {
    return typeof obj === 'number' || obj instanceof Number;
  }

  static promisify(nodeFunction) {
    function promisified(...args) {
      return new Promise((resolve, reject) => {
        function callback(err, ...result) {
          if (err)
            return reject(err);
          if (result.length === 1)
            return resolve(result[0]);
          return resolve(result);
        }
        nodeFunction.call(null, ...args, callback);
      });
    }
    return promisified;
  }

  /**
   * @param {!NodeJS.EventEmitter} emitter
   * @param {string} eventName
   * @param {function} predicate
   * @return {!Promise}
   */
  static waitForEvent(emitter, eventName, predicate, timeout) {
    let eventTimeout, resolveCallback, rejectCallback;
    const promise = new Promise((resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    });
    const listener = Helper.addEventListener(emitter, eventName, event => {
      if (!predicate(event))
        return;
      cleanup();
      resolveCallback(event);
    });
    if (timeout) {
      eventTimeout = setTimeout(() => {
        cleanup();
        rejectCallback(new TimeoutError('Timeout exceeded while waiting for event'));
      }, timeout);
    }
    function cleanup() {
      Helper.removeEventListeners([listener]);
      clearTimeout(eventTimeout);
    }
    return promise;
  }
}

/**
 * @param {*} value
 * @param {string=} message
 */
function assert(value, message) {
  if (!value)
    throw new Error(message);
}

module.exports = {
  helper: Helper,
  assert,
  debugError
};