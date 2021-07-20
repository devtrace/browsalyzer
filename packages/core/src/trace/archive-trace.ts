import { Archive, Entry, Header } from '@tracerbench/har';
import { SessionConnection } from 'chrome-debugging-client';
import Protocol from 'devtools-protocol';

import type { Screenshot } from '../util/interfaces';
import { IConditions } from './conditions';
import {
  createBrowser,
  emulate,
  enforcePaintEventFn,
  getBrowserArgs,
  getTab,
  setCookies
} from './utils';
import debug = require('debug');

// run with DEBUG=* eg.`DEBUG=* tracerbench record-har`
// run with DEBUG=tracerbench:archive-trace eg.`DEBUG=tracerbench:archive-trace tracerbench record-har`
const debugCallback = debug('tracerbench:archive-trace');

type NetworkRequestStacks = {
  stackA: Protocol.Network.ResponseReceivedEvent[];
  stackB: Protocol.Network.ResponseReceivedEvent[];
};

type HARArchiveResponse = {
  archive: Archive;
  screenshotData?: Screenshot[];
};

const networkRequestStacks: NetworkRequestStacks = {
  stackA: [],
  stackB: []
};

export async function recordHARClient(
  url: string,
  cookies: Protocol.Network.CookieParam[],
  marker: string,
  conditions: IConditions,
  headless = false,
  altBrowserArgs?: string[],
  screenshots?: boolean
): Promise<HARArchiveResponse> {
  const archive: Archive = {
    log: {
      version: '0.0.0',
      creator: {
        name: 'TracerBench',
        version: '0.0.0'
      },
      entries: []
    }
  };
  const screenshotData: Screenshot[] = [];
  const browserArgs = getBrowserArgs(altBrowserArgs);
  const browser = await createBrowser(browserArgs, headless);
  try {
    const chrome = await getTab(browser.connection);

    chrome.on('Network.requestWillBeSent', (params) => {
      debugCallback('Network.requestWillBeSent %o', params);
    });

    chrome.on('Network.responseReceived', (params) => {
      const { statusText, status } = params.response;

      if (
        params.type === 'Other' ||
        statusText === 'No Content' ||
        status === 204 ||
        status === 206 ||
        (statusText !== 'OK' && status >= 400)
      ) {
        debugCallback('NOT-INCLUDED %o', params);
        return;
      }

      debugCallback('Network.responseReceived %o', params);
      networkRequestStacks.stackA.push(params);
    });

    // enable Network / Page / Runtime
    await Promise.all([
      chrome.send('Page.enable'),
      chrome.send('Network.enable'),
      chrome.send('Runtime.enable')
    ]);

    // clear and disable cache
    await chrome.send('Network.clearBrowserCache');
    // disable cache
    await chrome.send('Network.setCacheDisabled', { cacheDisabled: true });

    await emulate(chrome, conditions);

    // set cookies
    await setCookies(chrome, cookies);

    // navigate to the url
    await chrome.send('Page.navigate', { url });
    // add performance observer script to eval
    // custom marker to extend past loadEventFired
    // window.performance.getEntries()
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        ${enforcePaintEventFn}
        self.__TBMarkerPromise = new Promise(resolve => {
          const observer = new PerformanceObserver((list) => {
            if (list.getEntriesByName(${JSON.stringify(marker)}).length > 0) {
              requestAnimationFrame(() => {
                enforcePaintEvent();
                requestIdleCallback(() => {
                  resolve();
                });
              });
              observer.disconnect();
            }
        });
        observer.observe({ entryTypes: ["mark", "navigation"] });
      });`
    });
    // default is loadEventFired
    await chrome.until('Page.loadEventFired');

    // eval
    const evalPromise = chrome.send('Runtime.evaluate', {
      expression: `__TBMarkerPromise`,
      awaitPromise: true
    });

    let timeoutId: NodeJS.Timeout;
    const timeout = new Promise((reject) => {
      timeoutId = setTimeout(() => {
        clearTimeout(timeoutId);
        reject('Promise timed out after waiting for 20 seconds');
      }, 20000);
    });

    await Promise.race([evalPromise, timeout]).then(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });

    // screenshot app
    if (screenshots) {
      const appScreenshot = await chrome.send('Page.captureScreenshot');
      screenshotData.push({ data: appScreenshot.data, name: 'app' });
    }

    archive.log.entries = await processEntriesLoop(chrome, url);

    await Promise.all([
      chrome.send('Network.disable'),
      chrome.send('Runtime.disable')
    ]);

    debugCallback('Network.disable');
    debugCallback('Runtime.disable');

    await chrome.send('Page.close');
    debugCallback('Page.close');
  } catch (e) {
    throw new Error(e);
  } finally {
    if (browser) {
      await browser.dispose();
      debugCallback('browser.dispose()');
    }
  }

  return {
    archive,
    screenshotData
  };
}

export async function processEntriesLoop(
  chrome: SessionConnection,
  entryURL: string
): Promise<Entry[]> {
  debugCallback(
    'processEntriesLoop() %o',
    `${networkRequestStacks.stackA.length} entries`
  );
  let networkEntries: Entry[] = [];
  // empty A into B
  networkRequestStacks.stackB = networkRequestStacks.stackA;
  networkRequestStacks.stackA = [];

  // process B and empty
  networkEntries = await processEntries(
    networkRequestStacks.stackB,
    chrome,
    entryURL
  );
  networkRequestStacks.stackB = [];

  // check A for new entries
  // if empty return
  if (networkRequestStacks.stackA.length > 0) {
    debugCallback(
      'processEntriesLoop() %o',
      `${networkRequestStacks.stackA.length} entries`
    );

    networkEntries = networkEntries.concat(
      await processEntriesLoop(chrome, entryURL)
    );
  }

  return networkEntries;
}

export async function processEntries(
  networkRequests: Protocol.Network.ResponseReceivedEvent[],
  chrome: SessionConnection,
  entryURL: string
): Promise<Entry[]> {
  debugCallback('processEntries()');
  let entries = [];

  for (let i = 0; i < networkRequests.length; i++) {
    debugCallback('processEntries.entry %o', networkRequests[i].response.url);
    const { requestId, response } = networkRequests[i];
    const [body, postData] = await Promise.all([
      getResponseBody(requestId, chrome),
      getRequestPostData(requestId, chrome)
    ]);
    const {
      url,
      requestHeaders,
      status,
      statusText,
      headers,
      mimeType,
      protocol
    } = response;

    let requestMethod = handleHeaders(requestHeaders)[0].value || '';
    if (requestMethod === 'GET' && postData.length > 0) {
      requestMethod = 'POST';
    }

    const entry: Entry = {
      time: 0,
      cache: {},
      timings: {
        send: 0,
        wait: 0,
        receive: 0
      },
      serverIPAddress: response.remoteIPAddress || '',
      startedDateTime: new Date().toISOString(),
      request: {
        url,
        method: requestMethod,
        httpVersion: protocol || '',
        cookies: [],
        headers: handleHeaders(requestHeaders),
        queryString: [],
        headersSize: 0,
        bodySize: 0
      },
      response: {
        status,
        statusText,
        httpVersion: protocol || '',
        cookies: [],
        headers: handleHeaders(headers),
        redirectURL:
          url.split('?', 1)[0] === entryURL.split('?', 1)[0] ? entryURL : '',
        headersSize: 0,
        bodySize: 0,
        content: {
          text: body,
          size: 0,
          mimeType
        }
      }
    };

    entries.push(entry);
  }

  entries = handleRedirectContent(entries, entryURL);

  return entries;
}

// handles usecase when a seperate har entry from a redirect contains the html
function handleRedirectContent(entries: Entry[], entryURL: string): Entry[] {
  let counter = 0;
  let redirectContent;

  entries.forEach((entry, i) => {
    // grab entry if its the same the the HAR url and the content text is empty
    if (entry.request.url === entryURL && !entry.response.content.text) {
      counter = i;
    }

    // grab the redirect content
    if (
      entry.response.redirectURL.length > 0 &&
      entry.request.url !== entryURL
    ) {
      redirectContent = entry.response.content;
    }
  });

  // if there isn't redirect content then keep the content as is otherwise set
  entries[counter].response.content = !redirectContent
    ? entries[counter].response.content
    : redirectContent;

  return entries;
}

export async function getResponseBody(
  requestId: string,
  chrome: SessionConnection
): Promise<string> {
  try {
    const { body } = await chrome.send('Network.getResponseBody', {
      requestId
    });
    return body;
  } catch (error) {
    return '';
  }
}

async function getRequestPostData(
  requestId: string,
  chrome: SessionConnection
): Promise<string> {
  try {
    const { postData } = await chrome.send('Network.getRequestPostData', {
      requestId
    });

    return postData;
  } catch (error) {
    return '';
  }
}

export function handleHeaders(headers?: Protocol.Network.Headers): Header[] {
  if (!headers) {
    return [{ name: '', value: '' }];
  }

  return Object.entries(headers).map((e) => {
    return { name: e[0], value: e[1] };
  });
}
