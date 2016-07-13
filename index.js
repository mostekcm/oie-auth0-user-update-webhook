var express  = require('express');
var auth0    = require('auth0-oauth2-express');
var Webtask  = require('webtask-tools');
var app      = express();
var metadata = require('./webtask.json');
var request = require('superagent');
var async   = require('async');
var express = require('express');
var Request  = require('superagent');
var memoizer = require('lru-memoizer');
var jwt = require('jsonwebtoken');


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

	var startCheckpointId = typeof data === 'undefined' ? null : data.checkpointId;

	console.log("Data checkpointId", startCheckpointId);
	
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
				console.log('Error sending request:', err, res.body);
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
			console.log('Error sending request:', err, res.body);
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


module.exports = app;
