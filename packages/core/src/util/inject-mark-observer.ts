import { ProtocolConnection } from 'chrome-debugging-client';
import Protocol from 'devtools-protocol';
import { RaceCancellation } from 'race-cancellation';
import { enforcePaintEventFn } from '../trace/utils';

import isNavigationTimingMark from './is-navigation-timing-mark';

export type WaitForMark = (raceCancellation: RaceCancellation) => Promise<void>;

export default async function injectMarkObserver(
  page: ProtocolConnection,
  mark: string,
  variable = '__tracerbench'
): Promise<(raceCancelation: RaceCancellation) => Promise<void>> {
  const scriptSource = isNavigationTimingMark(mark)
    ? navigationObserver(variable)
    : markObserver(mark, variable);

  await page.send('Page.addScriptToEvaluateOnLoad', {
    scriptSource
  });

  return (raceCancelation: RaceCancellation) =>
    waitForMark(page, variable, mark, raceCancelation);
}

function markObserver(mark: string, variable: string): string {
  return `"use strict";
  ${enforcePaintEventFn}
var ${variable} =
  self === top &&
  opener === null &&
  new Promise((resolve) =>
    new PerformanceObserver((records, observer) => {
      if (records.getEntriesByName(${JSON.stringify(mark)}).length > 0) {
        requestAnimationFrame(() => {
          enforcePaintEvent();
          requestIdleCallback(() => {
            resolve();
          });
        });
        observer.disconnect();
      }
    }).observe({ type: "mark" })
  );`;
}

function navigationObserver(variable: string): string {
  return `"use strict";
  ${enforcePaintEventFn}
var ${variable} =
  self === top &&
  opener === null &&
  new Promise((resolve) =>
    new PerformanceObserver((records, observer) => {
      if (records.getEntries().length > 0) {
        requestAnimationFrame(() => {
          enforcePaintEvent();
          requestIdleCallback(() => {
            resolve();
          });
        });
        observer.disconnect();
      }
    }).observe({ type: "navigation" })
  );`;
}

async function waitForMark(
  page: ProtocolConnection,
  expression: string,
  mark: string,
  raceCancelation: RaceCancellation
): Promise<void> {
  let result: Protocol.Runtime.EvaluateResponse;
  try {
    result = await page.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue: true
      },
      raceCancelation
    );
  } catch (original) {
    throw waitForMarkError(mark, { original });
  }
  const { exceptionDetails } = result;
  if (exceptionDetails !== undefined) {
    throw waitForMarkError(mark, { exceptionDetails });
  }
}

interface ErrorDetail {
  exceptionDetails?: Protocol.Runtime.ExceptionDetails;
  original?: Error;
}

function waitForMarkError(
  mark: string,
  { original, exceptionDetails }: ErrorDetail
): Error {
  let message = `errored while waiting for ${mark}`;
  if (exceptionDetails) {
    message += `: ${exceptionDetails.text}`;
  }
  if (original) {
    message += `: ${original.message}`;
  }
  const error: Error & {
    exceptionDetails?: Protocol.Runtime.ExceptionDetails;
    original?: Error;
  } = new Error(message);
  error.exceptionDetails = exceptionDetails;
  error.original = original;
  return error;
}
