const { bufferToString } = require('./binary-util');

/**
 * Request handler (simply wrap http requests and responses)
 * @param request {IncomingMessage}
 * @param response {ServerResponse}
 */
function requestHandler(request, response) {
  let urlObj = new URL(request.url, `http://${request.headers.host}`);

  // requestArgs are query string args, unlike args that are groups
  // of path matched by RegExp. let implement a wrapper for ease of access
  const requestArgs = {
    get: function (name) {
      let text = urlObj.searchParams.get(name);
      return text ? text : undefined;
    },

    getJson: function (name) {
      let text = this.get(name);
      return text ? JSON.parse(text) : undefined;
    },

    getInt: function (name) {
      return parseInt(this.get(name));
    },

    getFloat: function (name) {
      return parseFloat(this.get(name));
    },

    getBoolean: function (name) {
      return this.getJson(name);
    },

    [Symbol.iterator]: function () {
      return urlObj.searchParams[Symbol.iterator];
    }
  };

  return {
    isMatch: false,
    isClosed: false,
    args: [],
    requestArgs,

    /**
     * Match request with given path & (optional) method
     * @param path {string|RegExp}
     * @param method {'GET'|'POST'|'PUT'|'DELETE'|'PATCH'|'*'}
     * @param makeResponse {*}
     */
    on: function (path, method, makeResponse) {
      let match = !this.isClosed && (!method || method === '*' || method === request.method) && urlObj.pathname.match(path);
      if (match) {
        this.isMatch = true;
        if (match.groups) {
          // used object argument
          this.args = [match.groups];
        } else {
          // used positional arguments
          this.args = match.slice(1);
        }
        this.respond(makeResponse);
      }
    },

    /**
     * Get raw data of the request
     * @return {Promise<Buffer>}
     */
    getData: function () {
      return new Promise((resolve) => {
        let data = [];
        request.on('data', (d) => {
          data.push(d);
        });
        request.on('end', () => {
          resolve(Buffer.concat(data));
        });
      });
    },

    /**
     * Respond to the matched request with given response
     * @param makeResponse {*}
     */
    respond: function (makeResponse) {
      // close immediately, in order to not match further asynchronous responses
      this.isClosed = true;
      let actualResponse;
      if (typeof makeResponse == 'function') {
        try {
          actualResponse = makeResponse(...this.args);
        } catch (e) {
          this.error(e);
          return;
        }
        if (actualResponse && typeof actualResponse.then == 'function') {
          actualResponse.then((resolveResponse) => {
            this.respond(resolveResponse);
          }, (errorResponse) => {
            this.error(errorResponse);
          });
          return;
        }
      } else {
        actualResponse = makeResponse;
      }

      if (actualResponse && typeof actualResponse.status == 'function'
          && typeof actualResponse.headers == 'function' &&
          (typeof actualResponse.buffer == 'function' || typeof actualResponse.text == 'function')) {
        // if actualResponse is something Response-like,
        // fill the response out of it
        response.statusCode = actualResponse.status();
        for (let [key, value] of Object.entries(actualResponse.headers())) {
          response.setHeader(key.toString(), value.toString());
        }
        if (typeof actualResponse.buffer == 'function') {
          actualResponse.buffer().then((buffer) => {
            response.end(bufferToString(buffer), 'binary');
          });
        } else {
          actualResponse.text().then((text) => {
            // imply, for now, that any text response is in UTF8,
            // though better to check the content-type
            response.end(text);
          });
        }
      } else if (typeof actualResponse == 'object') {
        // JSON response
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.write(JSON.stringify(actualResponse));
        response.end();
      } else {
        // respond with text/plain
        response.statusCode = 200;
        if (actualResponse && typeof actualResponse.toString == 'function') {
          response.setHeader('content-type', 'text/plain');
          response.write(actualResponse.toString());
        }
        response.end();
      }
    },

    /**
     * Respond with the error in JSON format
     * @param errorMessage {*}
     */
    error: function (errorMessage) {
      console.error(errorMessage);
      response.statusCode = 500;
      const body = {};
      if (errorMessage && typeof errorMessage.toString == 'function') {
        body.error = errorMessage.toString();
      }
      response.setHeader('content-type', 'application/json');
      response.write(JSON.stringify(body));
      response.end();
    },

    /**
     * Fallback with 404: Not Found error
     */
    fallback: function () {
      if (!this.isClosed) {
        response.statusCode = 404;
        response.setHeader('content-type', 'application/json');
        response.write(JSON.stringify({ error: 'Request does not match any handler: ' + request.url }));
        response.end();
      }
    }

  };
}

module.exports = requestHandler;
