const ENV = process.env.ENV;
const config = !ENV ? require('./app.config.json') : require(`./app.config.${ENV}.json`);
const { WebSocketServer } = require('ws');
const http = require('http');
const puppeteer = require('puppeteer-core');
const dns = require('dns');
const requestHandler = require('./util/request-handler');
const { bufferToBase64, base64ToBuffer } = require('./util/binary-util');
const { logger } = require('./util/infra-util');

// headers that we pass through
const proxyHeaderNames = ['content-type'];

// pool of puppeteer-controlled browsers, format of the object TBD
const pool = new Array(config.browserPool.capacity);

// map of the session ID to the index in the pool
const sessionToPoolNumber = {};

function sessionObj(session) {
  // get all stuff (browser, page, etc.) from session
  if (!(session in sessionToPoolNumber) || !pool[sessionToPoolNumber[session]]) {
    throw new Error('Session expired or non-existent.');
  }
  return pool[sessionToPoolNumber[session]];
}

async function ipifyBrowserUrl() {
  const url = config.browserPool.browserURL;
  const urlObj = new URL(url);
  const { address } = await dns.promises.lookup(urlObj.hostname, {
    family: 4,
    hints: dns.ADDRCONFIG,
  });

  urlObj.hostname = address;
  return urlObj.toString();
}

async function createSession() {
  const n = pool.findIndex((i) => !i);
  if (n === -1) {
    throw new Error('No browser is available.');
  }
  pool[n] = {};  // stake a slot before asynchronous browser initialization
  const browser = await puppeteer.connect({ browserURL: await ipifyBrowserUrl() });
  const page = await browser.newPage();
  const session = Math.random().toString().substring(2);
  pool[n] = {
    session,
    browser,
    page,
    interceptor: startIntercept(session, page),
    createdAt: Date.now(),
    accessedAt: Date.now()
  };
  sessionToPoolNumber[session] = n;
  return session;
}

async function deleteSession(session) {
  const n = sessionToPoolNumber[session];
  if (typeof n == 'number') {
    const { page, interceptor } = pool[n];
    await page.close();
    interceptor.clear();
    delete pool[n];
    delete sessionToPoolNumber[session];
  }
}

// clean up old sessions
setInterval(() => {
  pool.forEach((obj, i) => {
    if (obj && (
        (obj.accessedAt && Date.now() - obj.accessedAt > config.browserPool.inactivityTimeout)
        || (obj.createdAt && Date.now() - obj.createdAt > config.browserPool.liveTimeout)
    )) {
      deleteSession(obj.session);
    }
  });
}, 20000);

function startIntercept(session, page) {
  const interceptor = {
    storage: {},

    getResponse: async function (url) {
      if (!(url in this.storage)) {
        this.storage[url] = {};
        const promise = new Promise((resolve, reject) => {
          this.storage[url].resolve = resolve;
          this.storage[url].reject = reject;
        });
        this.storage[url].promise = promise;
        this.storage[url].response = null;
      }

      if (this.storage[url].response) {
        return this.storage[url].response;
      }

      // todo implement timeout
      this.storage[url].response = await this.storage[url].promise;
      return this.storage[url].response;
    },

    onRequest: function (request) {
      // send message to the websocket
      const obj = sessionObj(session);
      if ('ws' in obj) {
        obj.ws.send(JSON.stringify({
          type: "request",
          request: { url: request.url(), headers: request.headers() },
          session
        }));
      }
    },

    onResponse: function (response) {
      // save response to handle /ref
      const url = response.url();
      (this.storage[url] ||= {}).response = response;
      if (this.storage[url].resolve) {
        this.storage[url].resolve(response);
      }

      // send message to the websocket
      const obj = sessionObj(session);
      if ('ws' in obj) {
        obj.ws.send(JSON.stringify({
          type: "response",
          response: {
            url,
            status: response.status(),
            headers: response.headers()
          },
          session
        }));
      }
    },

    start: function () {
      this.requestHandler = this.onRequest.bind(this);
      this.responseHandler = this.onResponse.bind(this);
      page.on('request', this.requestHandler);
      page.on('response', this.responseHandler);
    },

    stop: function () {
      page.off('request', this.requestHandler);
      page.off('response', this.responseHandler);
    },

    clear: function () {
      Object.entries(this.storage).forEach(([url, value]) => {
        if (value.reject) {
          value.reject(`Request interrupted`);
        }
      });
      this.storage = {};
    }
  };

  interceptor.start();
  return interceptor;
}

// server will serve session requests and handle references.
// GET /session  -- create a session
// GET /<session-id>/visit/<URL>  -- open a page in this session
// GET /<session-id>/ref/<URL>  -- get a resource referenced by the page
// *** /<session-id>/fetch/<URL>  -- fetch a resource on behalf of the page
// DELETE /<session-id>  -- terminate session
const server = http.createServer();

server.on('request', (request, response) => {
  // let implement some helpers
  function getProxyHeaders(headers) {
    let proxyHeaders = {};
    for (let name of proxyHeaderNames) {
      if (name in headers) {
        proxyHeaders[name] = headers[name];
      }
    }
    return proxyHeaders;
  }

  async function getPatchedPageContent(session) {
    // clone document, and do some manipulations with it,
    // to be able to show it in iframe with correct (i.e. proxy) refs.
    // "/proxy/" is a public path of our web server
    const { page } = sessionObj(session);
    const proxyroot = '/proxy/' + session;
    const proxyhost = request.headers.host;
    const targethost = new URL(page.url()).hostname;
    const patchedDoc = await page.evaluate((proxyroot, proxyhost, targethost) => {
      const doc = window.document.cloneNode(true);
      let nodeList;
      nodeList = doc.querySelectorAll(':not(a)[href]');
      for (let i = 0; i < nodeList.length; i++) {
        let element = nodeList.item(i);
        const ref = element.href;
        element.href = proxyroot + '/ref/' + encodeURIComponent(ref);
      }
      nodeList = doc.querySelectorAll('a[href]');
      for (let i = 0; i < nodeList.length; i++) {
        let element = nodeList.item(i);
        const ref = element.href;
        const refUrl = new URL(ref);
        if (refUrl.protocol.match(/http[s]?/)) {
          element.href = proxyroot + '/visit/' + encodeURIComponent(ref);
        }
      }
      nodeList = doc.querySelectorAll('*[src]');
      for (let i = 0; i < nodeList.length; i++) {
        let element = nodeList.item(i);
        const src = element.src;
        element.src = proxyroot + '/ref/' + encodeURIComponent(src);
      }
      // monkey-patch `fetch`
      const script = doc.createElement('script');
      const scriptContent = doc.createTextNode(`const stashFetch = window.fetch;
window.fetch = function () {
  let url = arguments[0];
  if (typeof url == "string") {
    url = new URL(new Request(url).url);
  } else if (url instanceof Request) {
    url = new URL(url.url);
  }
  let newUrl;
  if (url && url.hostname === "${proxyhost}") {
    // request is made to our proxy host;
    // that can happen if relative location
    url.hostname = "${targethost}";
  }
  if (url && url.hostname === "${targethost}") {
    // request is made to the target, and
    // should be redirected to proxy...
    let newUrl = "${proxyroot}" + "/fetch/" + encodeURIComponent(url.pathname);
    if (typeof arguments[0] == "string") {
      arguments[0] = newUrl;
    } else if (arguments[0] instanceof Request) {
      arguments[0] = new Request(newUrl, ...arguments[0]);
    }
  }
  return stashFetch(...arguments);
}`);
      script.appendChild(scriptContent);
      doc.head.appendChild(script);
      // return modified document as a string
      const serializer = new XMLSerializer();
      return serializer.serializeToString(doc);
    }, proxyroot, proxyhost, targethost);

    return patchedDoc;
  }

  function getPatchedPageResponse(session, response) {
    return {
      status: function () {
        return response.status();
      },
      headers: function () {
        return getProxyHeaders(response.headers());
      },
      text: function () {
        return getPatchedPageContent(session);
      },
    };
  }

  function getPublicEndpoint() {
    // endpoint of our websocket server to the outside world
    return config.endpoint;
  }

  // transform request to match relatively to server location
  if (config.server.location && request.url.startsWith(config.server.location)) {
    request.url = request.url.substring(config.server.location.length);
  }

  const handler = requestHandler(request, response);

  handler.on(/^\/session$/, 'GET', async () => {
    const session = await createSession();

    return { session, endpoint: getPublicEndpoint(), success: true };
  });

  handler.on(/^\/(\d+)\/visit\/(.*)/, 'GET', async (session, url) => {
    const obj = sessionObj(session);
    obj.accessedAt = Date.now();
    const { page, interceptor } = obj;
    url = decodeURIComponent(url);
    interceptor.clear();
    const response = await page.goto(url, handler.requestArgs.getJson('options'));
    return getPatchedPageResponse(session, response);
  });

  handler.on(/^\/(\d+)\/ref\/(.*)/, 'GET', async (session, url) => {
    const obj = sessionObj(session);
    const { page, interceptor } = obj;
    url = decodeURIComponent(url);
    // check relative url and make it absolute according to currently opened
    // page, this URL can happen e.g. if CSS links to some images...
    if (!/^[a-z+]+:\/\//.test(url)) {
      url = new URL(url, page.url()).toString();
    }
    const response = await interceptor.getResponse(url);
    return {
      status: function () {
        return response.status()
      },
      headers: function () {
        return getProxyHeaders(response.headers())
      },
      buffer: function () {
        return response.buffer()
      }
    };
  });

  handler.on(/^\/(\d+)\/fetch\/(.*)/, '*', async (session, url) => {
    const obj = sessionObj(session);
    obj.accessedAt = Date.now();
    const { page } = obj;
    url = decodeURIComponent(url);
    const method = request.method;
    const headers = request.headers;
    const body = /* base64-encoded body to pass to the browser */
        bufferToBase64(await handler.getData());
    const result = await page.evaluate(async (url, method, headers, body) => {
      const init = { method, headers };
      if (body && body.length) {
        init.body = Uint8Array.from(atob(body), (c) => c.codePointAt(0)).buffer;
      }
      const response = await fetch(url, init);
      const responseArrayBuffer = await response.arrayBuffer();
      const responseBody = btoa(String.fromCodePoint.apply(null, new Uint8Array(responseArrayBuffer)));
      const responseHeaders = {};
      for (const [key, value] of response.headers.entries()) {
        responseHeaders[key] = value;
      }
      return {
        status: response.status,
        headers: responseHeaders,
        body: responseBody
      };
    }, url, method, headers, body);

    return {
      status: function () {
        return result.status;
      },
      headers: function () {
        return getProxyHeaders(result.headers);
      },
      buffer: function () {
        return Promise.resolve(base64ToBuffer(result.body));
      }
    };
  });

  handler.on(/^\/(\d+)/, 'DELETE', async (session) => {
    deleteSession(session);
    return { success: true };
  });

  handler.fallback();
});

server.listen(config.server.port, '0.0.0.0');

// Web socket server, for handling commands, such as `goto` or `click`.
// Also it can execute crawlers.
// Received message format:
// {"method": ..., "target": "page", "payload": ...}  -- method and arguments
// of Puppeteer's Page
// {"method": ..., "target": "browser", "payload": ...}  -- method and arguments
// of Puppeteer's Browser
// {"script": ...}  -- script to execute,
// script must be a function declaration (no call, no export statements), with
// a single argument of type Page, which returns a Promise of 2D array of data.
//
// Sent message format:
// {"type": "result", "result": ...}  -- method execution finished, or promise
// returned by method resolved
// {"type": "error", "error": ...}  -- method threw an exception, I guess?
// {"type": "request", "request": ...}  -- request sent by the page
// {"type": "response", "response": ...}  -- response received by the page
//
// Each incoming and outgoing message contain "session" which identify
// browser session, and optional "id" to match method results to the call.
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('error', logger.warn);

  ws.on('message', (data) => {
    const message = JSON.parse(data);
    const session = message.session;
    const obj = sessionObj(session);
    const { page, browser } = obj;
    const id = message.id;

    // save websocket to the session to send events like requests/responses
    obj.ws = ws;

    function sendMessage(message) {
      ws.send(JSON.stringify({ ...message, session, id }));
    }

    function sendResult(result) {
      sendMessage({ type: "result", result });
    }

    function sendError(error) {
      logger.warn(error);
      sendMessage({ type: "error", error: error.toString() });
    }

    try {
      if (message.method) {
        obj.accessedAt = Date.now();
        let args = [];
        if (message.payload) {
          args = message.payload;
        }
        let result;
        if (message.target === 'page') {
          result = page[message.method](...args);
        } else if (message.target === 'browser') {
          result = browser[message.method](...args);
        } else {
          throw new Error(`Invalid method target: ${message.target}`);
        }
        if (result === undefined || result == null) {
          sendResult(null);
        } else if (typeof result.then == 'function') {
          result.then(sendResult, sendError);
        } else {
          sendResult(result);
        }
      } else if (message.script) {
        obj.accessedAt = Date.now() + config.browserPool.scriptTimeout;
        const f = new Function('page', `return (${message.script})(page);`);
        f(page).then(sendResult, sendError);
      } else {
        logger.warn("Bad command, ignore");
      }
    } catch (e) {
      sendError(e);
    }
  });
});
