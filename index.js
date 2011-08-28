/**
 * restalytics.js
 * monitoring library & agent for RESTalytics
 *
 * Usage:
 *   require('restalytics').apiKey('mySecretApiKey');
 *
 * Call this module from your main entry point, before creating any HTTP
 * Server objects. It should be called as early as possible, preferably
 * before other require()s.
 *
 * @author Amir Malik
 */

var http = require('http'),
     url = require('url');

var _listen = http.Server.prototype.listen;

var MIN_FLUSH_WAIT_TIME = 5000;
var MAX_ITEMS_PER_FLUSH = 100;
var MAX_BACKLOG = 10000;

var mApiKey;
var mDevMode = false;
var mDataQueue = [];
var mLastFlush = new Date(0);

function restore_queue(data) {
  while(data.length != 0) {
    mDataQueue.unshift(data.pop());
  }
}

function flush_data_queue() {
  if(new Date() - mLastFlush < MIN_FLUSH_WAIT_TIME || mDataQueue.length == 0)
    return;

  if(mDataQueue.length > MAX_BACKLOG)
    mDataQueue.splice(0, MAX_ITEMS_PER_FLUSH);

  var options = {
    method: 'POST',
    host: 'restalytics.com',
    port: 80,
    path: '/api/data',
  };

  if(mDevMode) {
    options.host = 'localhost';
    options.port = 7777;
  }

  var req = http.request(options, function(res) {
    if(res.statusCode != 200) {
      console.error('RESTalytics: unable to flush data. HTTP status: %d', res.statusCode);
      console.error('RESTalytics: pending_data', pending_data);

      // restore pending data to the head and try again in the next flush
      restore_queue(pending_data);
    }
  }).on('error', function(e) {
    console.error('RESTalytics: POST error', e.message);

    // restore pending data to the head and try again in the next flush
    restore_queue(pending_data);
  });

  // grab some items off the head
  var pending_data = mDataQueue.splice(0, MAX_ITEMS_PER_FLUSH);

  // serialize it
  var ser_data = JSON.stringify({
    count: pending_data.length,
    data: pending_data
  });

  req.setHeader('Authorization', mApiKey);
  req.setHeader('Content-Type', 'application/json');
  req.setHeader('Content-Length', ser_data.length);
  req.end(ser_data);

  mLastFlush = new Date();
}

// monkey patch the listen method so we can install our second-stage patcher
http.Server.prototype.listen = function() {
  this.on('request', function(req, res) {
    var parsed_url = url.parse(req.url, true);

    req._restalytics = {
      elapsed_time: 0,
      method: req.method,
      url: req.url,
      pathname: parsed_url.pathname,
      parameters: parsed_url.query,
      remote_addr: req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.connection.remoteAddress,
      request: {
        time: new Date(),
        length: req.headers['content-length'] || 0,
        contentType: req.headers['content-type'],
      },
      response: {
        length: 0,
      }
    };

    var     _res_write = res.write,
        _res_writeHead = res.writeHead,
              _res_end = res.end;

    res.write = function(chunk, encoding) {
      req._restalytics.response.length += chunk.length;

      return _res_write.apply(this, arguments);
    };

    res.writeHead = function(status) {
      req._restalytics.response.status = status;

      return _res_writeHead.apply(this, arguments);
    };

    res.end = function(data, encoding) {
      req._restalytics.elapsed_time = new Date() - req._restalytics.request.time;

      if(!req._restalytics.response.status)
        req._restalytics.response.status = res.statusCode;

      if(data)
        req._restalytics.response.length += data.length;

      if(req.body && ('POST' == req.method || 'PUT' == req.method)) {
        req._restalytics.request.body = req.body;
      }

      mDataQueue.push(req._restalytics);
      delete req._restalytics;

      return _res_end.apply(this, arguments);
    };
  });

  // make sure our listener fires first
  this.listeners('request').unshift(this.listeners('request').pop());

  return _listen.apply(this, arguments);
};

setInterval(flush_data_queue, MIN_FLUSH_WAIT_TIME);

exports.apiKey = function(apikey) {
  mApiKey = apikey;

  return {
    devMode: function(b) {
      mDevMode = b;
    }
  };
};
