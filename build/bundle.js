/******* oie-auth0-user-update-webhook *******/
module.exports =
/******/ (function(modules) { // webpackBootstrap
/******/    // The module cache
/******/    var installedModules = {};
 
/******/    // The require function
/******/    function __webpack_require__(moduleId) {
 
/******/        // Check if module is in cache
/******/        if(installedModules[moduleId])
/******/            return installedModules[moduleId].exports;
 
/******/        // Create a new module (and put it into the cache)
/******/        var module = installedModules[moduleId] = {
/******/            exports: {},
/******/            id: moduleId,
/******/            loaded: false
/******/        };
 
/******/        // Execute the module function
/******/        modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);
 
/******/        // Flag the module as loaded
/******/        module.loaded = true;
 
/******/        // Return the exports of the module
/******/        return module.exports;
/******/    }
 
 
/******/    // expose the modules object (__webpack_modules__)
/******/    __webpack_require__.m = modules;
 
/******/    // expose the module cache
/******/    __webpack_require__.c = installedModules;
 
/******/    // __webpack_public_path__
/******/    __webpack_require__.p = "/build/";
 
/******/    // Load entry module and return exports
/******/    return __webpack_require__(0);
/******/ })
/************************************************************************/
/******/ ([
/* 0 */
/***/ function(module, exports, __webpack_require__) {
 
    'use strict';
 
    var Auth0 = __webpack_require__(1);
    var request = __webpack_require__(2);
    var async = __webpack_require__(3);
    var express = __webpack_require__(4);
    var Webtask = __webpack_require__(5);
    var app = express();
    var Request = __webpack_require__(2);
    var memoizer = __webpack_require__(8);
    
    /******************************/
    var jwt = __webpack_require__(13);
    var metadata = __webpack_require__(14);
    /******************************/
    
    function lastLogCheckpoint(req, res) {
      var ctx = req.webtaskContext;
      var required_settings = ['AUTH0_DOMAIN', 'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET', 'AUTH0_APP_CLIENT_SECRET', 'AUTH0_APP_CLIENT_ID', 'UPDATE_USER_WEBHOOK_URL', 'DELETE_USER_WEBHOOK_URL'];
      var missing_settings = required_settings.filter(function (setting) {
        return !ctx.data[setting];
      });
 
      if (missing_settings.length) {
        console.log( missing_settings.join(', '))  
        return res.status(400).send({ message: 'Missing settings: ' + missing_settings.join(', ') });
      }
 
      // If this is a scheduled task, we'll get the last log checkpoint from the previous run and continue from there.
      req.webtaskContext.storage.get(function (err, data) {
        if (err && err.output.statusCode !== 404) return res.status(err.code).send(err);
 
        console.log("Data checkpointId", data.checkpointId);
        
        var startCheckpointId = typeof data === 'undefined' ? null : data.checkpointId;
 
        // Start the process.
        async.waterfall([function (callback) {
          var getLogs = function getLogs(context) {
            console.log('Logs from: ' + (context.checkpointId || 'Start') + '.');
 
            var take = Number.parseInt(ctx.data.BATCH_SIZE);
 
            take = take > 100 ? 100 : take;
 
            context.logs = context.logs || [];
 
            getLogsFromAuth0(req.webtaskContext.data.AUTH0_DOMAIN, req.webtaskContext.data.AUTH0_APP_CLIENT_ID, req.access_token, take, context.checkpointId, function (logs, err) {
              if (err) {
                console.log('Error getting logs from Auth0', err);
                return callback(err);
              }
 
              if (logs && logs.length) {
                logs.forEach(function (l) {
                  return context.logs.push(l);
                });
                context.checkpointId = context.logs[context.logs.length - 1]._id;
              }
 
              console.log('Total logs: ' + context.logs.length + '.');
              return callback(null, context);
            });
          };
 
          getLogs({ checkpointId: startCheckpointId });
        }, function (context, callback) {
          
          var endpoints_filter = ctx.data.AUTH0_API_ENDPOINTS ? ctx.data.AUTH0_API_ENDPOINTS.split(',') : "users";
          
          var request_matches_filter = function request_matches_filter(log) {
            
            if (!endpoints_filter || !endpoints_filter.length) return true;
            
            return log.details.request && log.details.request.path && endpoints_filter.some(function (f) {
              return log.details.request.path === '/api/v2/' + f || log.details.request.path.indexOf('/api/v2/' + f + '/') >= 0;
            });
            
          };
              
          var USER_API_URL = "/api/v2/users/";
          
          /******************************/
          var user_update_log = function only_user_update_filter(l) {
              
              var request = l.details.request;
              
              if(!request || request.method != "patch" || !request.path || request.path.indexOf(USER_API_URL) == -1) {
                  return false;
              }

              var userUrl = request.path;        
              return decodeURI(userUrl.replace(USER_API_URL, ""));
          };
          
          var user_delete_log = function only_user_update_filter(l) {
              
              var request = l.details.request;
              
              if(!request || request.method != "delete" || !request.path || request.path.indexOf(USER_API_URL) == -1) {
                  return false;
              }
              
              var userUrl = request.path;        
              return decodeURI(userUrl.replace(USER_API_URL, ""));
          };
          
          var user_email = function only_user_update_filter(l) {
              
              var request = l.details.request;
              
              if(!request || request.method != "delete" || !request.path || request.path.indexOf(USER_API_URL) == -1) {
                  return "";
              }
              
              return request.auth.user.email;
          };
          
          var user_success_signup_log = function only_user_update_filter(l) {
              
              if(l.details.request.type != "ss") {
                  return;
              }
  
              return l.details.request.user_id;
          };
          
          /******************************/

          context.logs = context.logs.filter(function (l) {
              return l.type === 'sapi' || l.type === 'fapi';
            })
          .filter(function(l) {
              return user_update_log(l) || user_success_signup_log(l) || user_delete_log(l);
          })
          .map(function (l) {
            var userUpdateId = user_update_log(l) || user_success_signup_log(l);
            var userDeleteId = user_delete_log(l);
            var userEmail = user_email(l);
            
            return {
              date: l.date,
              type: userDeleteId ? "delete" : "update",
              userId: userDeleteId || userUpdateId,
              email: userEmail
            };
          });
          
          callback(null, context);
        },
        //// STEP 4: Sending information
        function (context, callback) {
             
 
          if (!context.logs.length) {
            /******************************/
            console.log("Logs are empty");
            /******************************/
            return callback(null, context);
          }
 
          // Grouped by userId
          var logs = context.logs.reduce(function(acc, item) {  
              var key = item.userId;
              acc[key] = acc[key] || [];
              acc[key].push(item);
              return acc;
            }, {});
          
          Object.keys(logs).forEach(function(userId) {
              
           // Grouped by action and remove duplications  
            logs[userId] = logs[userId].reduce(function(acc, item) {  
                var key = item.type;
                
                if(!acc[key] || acc[key].date < item.date) {
                    acc[key] = {date: item.date, email: item.email};  
                } 
                
                return acc;
              }, {});

          })
          
          console.log("Logs:", logs);
          
          var concurrent_calls = ctx.data.WEBHOOK_CONCURRENT_CALLS || 5;
 
          async.eachLimit(Object.keys(logs), concurrent_calls, function (userId, cb) {
            
            console.log("Log:", logs[userId]);
            
            var deleteAction = logs[userId]["delete"];
            var updateAction = logs[userId]["update"];
            
            var deleteActionDate = deleteAction && deleteAction.date;
            var updateActionDate = updateAction && updateAction.date;
           
            var email = deleteAction && deleteAction.email;
            
            console.log("Email:", email);
            console.log("DeleteActionDate:", deleteActionDate);
            console.log("UpdateActionDate:", updateActionDate);
            
            if(updateActionDate && !deleteActionDate) {
                console.log("User(" + userId + ") profile is updated")
                updateOIEUserData(req, userId, ctx, function (err) {err ? cb(err) : cb();});
            } else if(!updateActionDate && deleteActionDate) {
                console.log("User(" + email + ") profile is removed")
                deleteOIEUserData(req, email, ctx, function (err) {err ? cb(err) : cb();});
            } else if(updateActionDate > deleteActionDate) {
                console.log("User(" + userId + ") profile is removed, but signed up again")
                updateOIEUserData(req, userId, ctx, function (err) {err ? cb(err) : cb();});
            } else if(updateActionDate < deleteActionDate) {
                console.log("User(" + email + ") profile is updated, but also removed")
                deleteOIEUserData(req, email, ctx, function (err) {err ? cb(err) : cb();});
            }

          }, function (err) {
            if (err) {
              return callback(err);
            }
 
            console.log('Upload complete.');
            return callback(null, context);
          });
        }], function (err, context) {
          if (err) {
            console.log('Job failed.');
 
            return req.webtaskContext.storage.set({ checkpointId: startCheckpointId }, { force: 1 }, function (error) {
              if (error) {
                console.log('Error storing startCheckpoint', error);
                return res.status(500).send({ error: error });
              }
 
              res.status(500).send({
                error: err
              });
            });
          }
 
          console.log('Job complete.');
 
          return req.webtaskContext.storage.set({
            checkpointId: context.checkpointId,
            totalLogsProcessed: context.logs.length
          }, { force: 1 }, function (error) {
            if (error) {
              console.log('Error storing checkpoint', error);
              return res.status(500).send({ error: error });
            }
 
            res.sendStatus(200);
          });
        });
      });
    }
 
    function updateOIEUserData(req, userId, ctx, cb) {
        
        var url = ctx.data.UPDATE_USER_WEBHOOK_URL;
        
        console.log('Sending to \'' + url + '\'');
        
        var log_converter = function log_converter(userResponse) {
            console.log("Create signed data for user(" + userResponse.user_metadata.userId + "), auth0 userId: " + userResponse.user_id)
            var secret = new Buffer(ctx.data.AUTH0_APP_CLIENT_SECRET, 'base64').toString('binary');
            return {'token' : jwt.sign(userResponse, secret)};
        };
        
        getUserDataFromAuth0(req.webtaskContext.data.AUTH0_DOMAIN, req.access_token, userId, function (userResponse, err) {
            if (err) {
              console.log('Error getting user data from Auth0', err);
              return callback(err);
            }
            
            request.post(url)
            .type('form')
            .send(log_converter(userResponse))
            .end(function (err, res) {
                if (err && !res.ok && res.status != 404) {
                    console.log('Error sending request:', err, JSON.stringify(res.body));
                    return cb(err);
                }
               
                if(res.status == 404) {
                    console.log('Resource is not found');
                }
                
                return cb();
            });

          });
        
    }
    
    function deleteOIEUserData(req, email, ctx, cb) {
        
        var url = ctx.data.DELETE_USER_WEBHOOK_URL;
        
        console.log('Sending to \'' + url + '\'');
        
        var log_converter = function log_converter(email) {
            console.log("Create delete signed data for user(" + email + ")");
            var secret = new Buffer(ctx.data.AUTH0_APP_CLIENT_SECRET, 'base64').toString('binary');
            return {'token' : jwt.sign({"email" : email}, secret)};
        };
        
        request.post(url)
        .type('form')
        .send(log_converter(email))
        .end(function (err, res) {
            if (err && !res.ok && res.status != 404) {
                console.log('Error sending request:', err, JSON.stringify(res.body));
                return cb(err);
            }
            
            if(res.status == 404) {
                console.log('Resource is not found');
            }
            
            return cb();
         });

    };
    
    function getLogsFromAuth0(domain, client_id, token, take, from, cb) {
      var url = 'https://' + domain + '/api/v2/logs';
 
      Request.get(url).set('Authorization', 'Bearer ' + token)
          .set('Accept', 'application/json')
          .query({ q: "client_id=" + client_id })
          .query({ take: take })
          .query({ from: from })
          .query({ sort: 'date:1' })
          .query({ per_page: take })
          .end(function (err, res) {
        if (err || !res.ok) {
          console.log('Error getting logs', err);
          cb(null, err);
        } else {
          console.log('x-ratelimit-limit: ', res.headers['x-ratelimit-limit']);
          console.log('x-ratelimit-remaining: ', res.headers['x-ratelimit-remaining']);
          console.log('x-ratelimit-reset: ', res.headers['x-ratelimit-reset']);
          cb(res.body);
        }
      });
    }
 
    function getUserDataFromAuth0(domain, token, userId, cb) {
        var url = 'https://' + domain + '/api/v2/users/' + encodeURI(userId);
  
        Request.get(url).set('Authorization', 'Bearer ' + token).set('Accept', 'application/json').end(function (err, res) {
          if (err || !res.ok) {
            console.log('Error getting logs', err);
            cb(null, err);
          } else {
            cb(res.body);
          }
        });
      }
    
    var getTokenCached = memoizer({
      load: function load(apiUrl, audience, clientId, clientSecret, cb) {
        Request.post(apiUrl).send({
          audience: audience,
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret
        }).type('application/json').end(function (err, res) {
          if (err || !res.ok) {
            cb(null, err);
          } else {
            cb(res.body.access_token);
          }
        });
      },
      hash: function hash(apiUrl) {
        return apiUrl;
      },
      max: 100,
      maxAge: 1000 * 60 * 60
    });
 
    app.use(function (req, res, next) {
      var apiUrl = 'https://' + req.webtaskContext.data.AUTH0_DOMAIN + '/oauth/token';
      var audience = 'https://' + req.webtaskContext.data.AUTH0_DOMAIN + '/api/v2/';
      var clientId = req.webtaskContext.data.AUTH0_CLIENT_ID;
      var clientSecret = req.webtaskContext.data.AUTH0_CLIENT_SECRET;
 
      getTokenCached(apiUrl, audience, clientId, clientSecret, function (access_token, err) {
        if (err) {
          console.log('Error getting access_token', err);
          return next(err);
        }
 
        req.access_token = access_token;
        next();
      });
    });
 
    app.get('/', lastLogCheckpoint);
    app.post('/', lastLogCheckpoint);
 
    app.get('/meta', function (req, res) {
        res.status(200).send(metadata);
    });
    
    module.exports = Webtask.fromExpress(app);
 
/***/ },
/* 1 */
/***/ function(module, exports) {
 
    module.exports = require("auth0@0.8.2");
 
/***/ },
/* 2 */
/***/ function(module, exports) {
 
    module.exports = require("superagent");
 
/***/ },
/* 3 */
/***/ function(module, exports) {
 
    module.exports = require("async");
 
/***/ },
/* 4 */
/***/ function(module, exports) {
 
    module.exports = require("express");
 
/***/ },
/* 5 */
/***/ function(module, exports, __webpack_require__) {
 
    exports.fromConnect = exports.fromExpress = fromConnect;
    exports.fromHapi = fromHapi;
    exports.fromServer = exports.fromRestify = fromServer;
 
 
    // API functions
 
    function fromConnect (connectFn) {
        return function (context, req, res) {
            var normalizeRouteRx = createRouteNormalizationRx(req.x_wt.jtn);
 
            req.originalUrl = req.url;
            req.url = req.url.replace(normalizeRouteRx, '/');
            req.webtaskContext = attachStorageHelpers(context);
 
            return connectFn(req, res);
        };
    }
 
    function fromHapi(server) {
        var webtaskContext;
 
        server.ext('onRequest', function (request, response) {
            var normalizeRouteRx = createRouteNormalizationRx(request.x_wt.jtn);
 
            request.setUrl(request.url.replace(normalizeRouteRx, '/'));
            request.webtaskContext = webtaskContext;
        });
 
        return function (context, req, res) {
            var dispatchFn = server._dispatch();
 
            webtaskContext = attachStorageHelpers(context);
 
            dispatchFn(req, res);
        };
    }
 
    function fromServer(httpServer) {
        return function (context, req, res) {
            var normalizeRouteRx = createRouteNormalizationRx(req.x_wt.jtn);
 
            req.originalUrl = req.url;
            req.url = req.url.replace(normalizeRouteRx, '/');
            req.webtaskContext = attachStorageHelpers(context);
 
            return httpServer.emit('request', req, res);
        };
    }
 
 
    // Helper functions
 
    function createRouteNormalizationRx(jtn) {
        var normalizeRouteBase = '^\/api\/run\/[^\/]+\/';
        var normalizeNamedRoute = '(?:[^\/\?#]*\/?)?';
 
        return new RegExp(
            normalizeRouteBase + (
            jtn
                ?   normalizeNamedRoute
                :   ''
        ));
    }
 
    function attachStorageHelpers(context) {
        context.read = context.secrets.EXT_STORAGE_URL
            ?   readFromPath
            :   readNotAvailable;
        context.write = context.secrets.EXT_STORAGE_URL
            ?   writeToPath
            :   writeNotAvailable;
 
        return context;
 
 
        function readNotAvailable(path, options, cb) {
            var Boom = __webpack_require__(6);
 
            if (typeof options === 'function') {
                cb = options;
                options = {};
            }
 
            cb(Boom.preconditionFailed('Storage is not available in this context'));
        }
 
        function readFromPath(path, options, cb) {
            var Boom = __webpack_require__(6);
            var Request = __webpack_require__(7);
 
            if (typeof options === 'function') {
                cb = options;
                options = {};
            }
 
            Request({
                uri: context.secrets.EXT_STORAGE_URL,
                method: 'GET',
                headers: options.headers || {},
                qs: { path: path },
                json: true,
            }, function (err, res, body) {
                if (err) return cb(Boom.wrap(err, 502));
                if (res.statusCode === 404 && Object.hasOwnProperty.call(options, 'defaultValue')) return cb(null, options.defaultValue);
                if (res.statusCode >= 400) return cb(Boom.create(res.statusCode, body && body.message));
 
                cb(null, body);
            });
        }
 
        function writeNotAvailable(path, data, options, cb) {
            var Boom = __webpack_require__(6);
 
            if (typeof options === 'function') {
                cb = options;
                options = {};
            }
 
            cb(Boom.preconditionFailed('Storage is not available in this context'));
        }
 
        function writeToPath(path, data, options, cb) {
            var Boom = __webpack_require__(6);
            var Request = __webpack_require__(7);
 
            if (typeof options === 'function') {
                cb = options;
                options = {};
            }
 
            Request({
                uri: context.secrets.EXT_STORAGE_URL,
                method: 'PUT',
                headers: options.headers || {},
                qs: { path: path },
                body: data,
            }, function (err, res, body) {
                if (err) return cb(Boom.wrap(err, 502));
                if (res.statusCode >= 400) return cb(Boom.create(res.statusCode, body && body.message));
 
                cb(null);
            });
        }
    }
 
 
/***/ },
/* 6 */
/***/ function(module, exports) {
 
    module.exports = require("boom");
 
/***/ },
/* 7 */
/***/ function(module, exports) {
 
    module.exports = require("request");
 
/***/ },
/* 8 */
/***/ function(module, exports, __webpack_require__) {
 
    /* WEBPACK VAR INJECTION */(function(setImmediate) {const LRU = __webpack_require__(11);
    const _ = __webpack_require__(12);
    const lru_params =  [ 'max', 'maxAge', 'length', 'dispose', 'stale' ];
 
    module.exports = function (options) {
      var cache = new LRU(_.pick(options, lru_params));
      var load = options.load;
      var hash = options.hash;
 
      var result = function () {
        var args = _.toArray(arguments);
        var parameters = args.slice(0, -1);
        var callback = args.slice(-1).pop();
 
        var key;
 
        if (parameters.length === 0 && !hash) {
          //the load function only receives callback.
          key = '_';
        } else {
          key = hash.apply(options, parameters);
        }
 
        var fromCache = cache.get(key);
 
        if (fromCache) {
          return setImmediate.apply(null, [callback, null].concat(fromCache));
        }
 
        load.apply(null, parameters.concat(function (err) {
          if (err) {
            return callback(err);
          }
 
          cache.set(key, _.toArray(arguments).slice(1));
 
          return callback.apply(null, arguments);
 
        }));
 
      };
 
      result.keys = cache.keys.bind(cache);
 
      return result;
    };
 
 
    module.exports.sync = function (options) {
      var cache = new LRU(_.pick(options, lru_params));
      var load = options.load;
      var hash = options.hash;
 
      var result = function () {
        var args = _.toArray(arguments);
 
        var key = hash.apply(options, args);
 
        var fromCache = cache.get(key);
 
        if (fromCache) {
          return fromCache;
        }
 
        var result = load.apply(null, args);
 
        cache.set(key, result);
 
        return result;
      };
 
      result.keys = cache.keys.bind(cache);
 
      return result;
    };
    /* WEBPACK VAR INJECTION */}.call(exports, __webpack_require__(9).setImmediate))
 
/***/ },
/* 9 */
/***/ function(module, exports, __webpack_require__) {
 
    /* WEBPACK VAR INJECTION */(function(setImmediate, clearImmediate) {var nextTick = __webpack_require__(10).nextTick;
    var apply = Function.prototype.apply;
    var slice = Array.prototype.slice;
    var immediateIds = {};
    var nextImmediateId = 0;
 
    // DOM APIs, for completeness
 
    exports.setTimeout = function() {
      return new Timeout(apply.call(setTimeout, window, arguments), clearTimeout);
    };
    exports.setInterval = function() {
      return new Timeout(apply.call(setInterval, window, arguments), clearInterval);
    };
    exports.clearTimeout =
    exports.clearInterval = function(timeout) { timeout.close(); };
 
    function Timeout(id, clearFn) {
      this._id = id;
      this._clearFn = clearFn;
    }
    Timeout.prototype.unref = Timeout.prototype.ref = function() {};
    Timeout.prototype.close = function() {
      this._clearFn.call(window, this._id);
    };
 
    // Does not start the time, just sets up the members needed.
    exports.enroll = function(item, msecs) {
      clearTimeout(item._idleTimeoutId);
      item._idleTimeout = msecs;
    };
 
    exports.unenroll = function(item) {
      clearTimeout(item._idleTimeoutId);
      item._idleTimeout = -1;
    };
 
    exports._unrefActive = exports.active = function(item) {
      clearTimeout(item._idleTimeoutId);
 
      var msecs = item._idleTimeout;
      if (msecs >= 0) {
        item._idleTimeoutId = setTimeout(function onTimeout() {
          if (item._onTimeout)
            item._onTimeout();
        }, msecs);
      }
    };
 
    // That's not how node.js implements it but the exposed api is the same.
    exports.setImmediate = typeof setImmediate === "function" ? setImmediate : function(fn) {
      var id = nextImmediateId++;
      var args = arguments.length < 2 ? false : slice.call(arguments, 1);
 
      immediateIds[id] = true;
 
      nextTick(function onNextTick() {
        if (immediateIds[id]) {
          // fn.call() is faster so we optimize for the common use-case
          // @see http://jsperf.com/call-apply-segu
          if (args) {
            fn.apply(null, args);
          } else {
            fn.call(null);
          }
          // Prevent ids from leaking
          exports.clearImmediate(id);
        }
      });
 
      return id;
    };
 
    exports.clearImmediate = typeof clearImmediate === "function" ? clearImmediate : function(id) {
      delete immediateIds[id];
    };
    /* WEBPACK VAR INJECTION */}.call(exports, __webpack_require__(9).setImmediate, __webpack_require__(9).clearImmediate))
 
/***/ },
/* 10 */
/***/ function(module, exports) {
 
    // shim for using process in browser
 
    var process = module.exports = {};
    var queue = [];
    var draining = false;
    var currentQueue;
    var queueIndex = -1;
 
    function cleanUpNextTick() {
        draining = false;
        if (currentQueue.length) {
            queue = currentQueue.concat(queue);
        } else {
            queueIndex = -1;
        }
        if (queue.length) {
            drainQueue();
        }
    }
 
    function drainQueue() {
        if (draining) {
            return;
        }
        var timeout = setTimeout(cleanUpNextTick);
        draining = true;
 
        var len = queue.length;
        while(len) {
            currentQueue = queue;
            queue = [];
            while (++queueIndex < len) {
                if (currentQueue) {
                    currentQueue[queueIndex].run();
                }
            }
            queueIndex = -1;
            len = queue.length;
        }
        currentQueue = null;
        draining = false;
        clearTimeout(timeout);
    }
 
    process.nextTick = function (fun) {
        var args = new Array(arguments.length - 1);
        if (arguments.length > 1) {
            for (var i = 1; i < arguments.length; i++) {
                args[i - 1] = arguments[i];
            }
        }
        queue.push(new Item(fun, args));
        if (queue.length === 1 && !draining) {
            setTimeout(drainQueue, 0);
        }
    };
 
    // v8 likes predictible objects
    function Item(fun, array) {
        this.fun = fun;
        this.array = array;
    }
    Item.prototype.run = function () {
        this.fun.apply(null, this.array);
    };
    process.title = 'browser';
    process.browser = true;
    process.env = {};
    process.argv = [];
    process.version = ''; // empty string to avoid regexp issues
    process.versions = {};
 
    function noop() {}
 
    process.on = noop;
    process.addListener = noop;
    process.once = noop;
    process.off = noop;
    process.removeListener = noop;
    process.removeAllListeners = noop;
    process.emit = noop;
 
    process.binding = function (name) {
        throw new Error('process.binding is not supported');
    };
 
    process.cwd = function () { return '/' };
    process.chdir = function (dir) {
        throw new Error('process.chdir is not supported');
    };
    process.umask = function() { return 0; };
 
 
/***/ },
/* 11 */
/***/ function(module, exports) {
 
    module.exports = require("lru-cache");
 
/***/ },
/* 12 */
/***/ function(module, exports) {
 
    module.exports = require("lodash");
 
/***/ },
/* 13 */
/***/ function(module, exports) {
    /******************************/
    module.exports = require('jsonwebtoken');
    /******************************/
 
/***/ },
/* 14 */
/***/ function(module, exports) {
    /******************************/
    module.exports = {
            "title": "OIE-Auth0 user update webhook",
            "name": "oie-auth0-user-update-webhook",
            "version": "1.0.5",
            "author": "OIEngine",
            "description": "Web hook for updating user profile on OIE side",
            "type": "cron",
            "logoUrl": "https://cdn.auth0.com/extensions/auth0-webhooks/assets/logo.svg",
            "repository": "https://github.com/oiengine/oie-auth0-user-update-webhook",
            "keywords": [
              "auth0",
              "extension"
            ],
            "schedule": "0 */1 * * * *",
            "auth0": {
              "scopes": "read:logs read:users"
            },
            "secrets": {
              "BATCH_SIZE": {
                "description": "The ammount of logs to be read on each execution. Maximun is 100.",
                "default": 100
              },
              "AUTH0_API_ENDPOINTS": {
                "description": "Allows you to filter specific API endpoints, comma separated.",
                "example": "e.g.: users, connections, rules, logs, emails, stats, clients, tenants",
                "default": "users"
              },
              "UPDATE_USER_WEBHOOK_URL":     {
                "required": true
              },
              "DELETE_USER_WEBHOOK_URL":     {
                "required": true
              },
              "WEBHOOK_CONCURRENT_CALLS":     {
                "description": "The maximum concurrent calls that will be made to your webhook",
                "default": 1
              },
              "AUTH0_APP_CLIENT_SECRET":     {
                "description": "Secret id of application, it is used to create a JWT token",
                "required": true
              },
              "AUTH0_APP_CLIENT_ID":     {
                "description": "Client id of application, it is used in filtering the logs, only logs from this application will be processed",
                "required": true
              }
            }
          };
    /******************************/
 
/***/ }

/******/ ]);