import type { Archive, Entry } from '@tracerbench/har';
import { readFileSync } from 'fs';
import type { IncomingMessage, Server, ServerResponse } from 'http';
import { createServer as httpCreateServer } from 'http';
import { charset } from 'mime-types';
import { gzipSync } from 'zlib';

import type { MapLike, Response, ServerDelegate } from '../types';

export default class ArchiveServer {
  private responses = createMap<Response>();

  constructor(private delegate: ServerDelegate) {}

  public loadArchive(path: string): void {
    this.addArchive(JSON.parse(readFileSync(path, 'utf8')));
  }

  public addArchive(har: Archive): void {
    this.addArchiveEntries(har.log.entries);
  }

  public addArchiveEntries(entries: Entry[]): void {
    for (const entry of entries) {
      this.addArchiveEntry(entry);
    }
  }

  public addArchiveEntry(entry: Entry): void {
    const key = this.delegate.keyForArchiveEntry(entry);
    if (!key) {
      return;
    }
    const response = this.buildResponseForArchiveEntry(entry, key);
    if (response) {
      this.addResponse(key, response);
    } else {
      // tslint:disable-next-line: no-console
      console.error(`unable to build response for key: ${key}`);
    }
  }

  public buildResponseForArchiveEntry(
    entry: Entry,
    key: string
  ): Response | undefined {
    const { status, content } = entry.response;
    if (content && status >= 200 && status < 300) {
      let { text } = content;
      const { encoding, mimeType } = content as {
        encoding: 'base64';
        mimeType: string;
      };

      let body: Buffer | undefined;

      if (text === undefined) {
        body = undefined;
      } else if (charset(mimeType) === 'UTF-8') {
        text = new Buffer(text, encoding).toString();

        if (this.delegate.textFor) {
          text = this.delegate.textFor(entry, key, text);
        }

        body = new Buffer(text);
      } else {
        body = new Buffer(text, encoding);
      }

      const compress =
        content.compression !== undefined && content.compression > 0;
      let response = this.buildResponse(status, mimeType, body, compress);
      if (this.delegate.finalizeResponse) {
        response = this.delegate.finalizeResponse(entry, key, response);
      }
      return response;
    }
    if (this.delegate.responseFor) {
      return this.delegate.responseFor(entry, key);
    }
  }

  public buildResponse(
    statusCode: number,
    mimeType: string,
    body: Buffer | undefined,
    compress: boolean
  ): Response {
    let headers: MapLike<string>;
    if (body && compress) {
      body = gzipSync(body, {
        level: 9
      });
      headers = this.buildHeaders(mimeType, body, true);
    } else {
      headers = this.buildHeaders(mimeType, body, false);
    }
    return { statusCode, headers, body };
  }

  public buildHeaders(
    mimeType: string,
    body: Buffer | undefined,
    compressed: boolean
  ): MapLike<string> {
    const headers: MapLike<string> = {
      'Content-Length': '' + (body ? body.byteLength : 0),
      'Content-Type': mimeType
    };
    if (compressed) {
      headers['Content-Encoding'] = 'gzip';
    }
    return headers;
  }

  public addResponse(key: string, response: Response): void {
    // tslint:disable-next-line: no-console
    console.log(`add:  ${key}`);
    this.responses[key] = response;
  }

  public setResponse(key: string, response: Response): void {
    // tslint:disable-next-line: no-console
    console.log(`set:  ${key}`);
    this.responses[key] = response;
  }

  public responseFor(key: string): Response | undefined {
    return this.responses[key];
  }

  public async handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const key = await Promise.resolve(
      this.delegate.keyForServerRequest(request)
    );
    if (key) {
      const res = this.responseFor(key);
      if (res) {
        // tslint:disable-next-line: no-console
        console.log(`hit:  ${key}`);
        response.writeHead(res.statusCode, res.headers);
        response.end(res.body);
      } else {
        // tslint:disable-next-line: no-console
        console.log(`miss: ${key}`);
      }
    }

    if (this.delegate.missingResponse && !response.headersSent) {
      await Promise.resolve(this.delegate.missingResponse(request, response));
    }

    if (!response.headersSent) {
      response.writeHead(404);
      response.end();
    }

    // tslint:disable-next-line: no-console
    console.log(response.statusCode, request.method, request.url);
  }

  public createServer(): Server {
    return httpCreateServer((req, res) => this.handle(req, res));
  }
}

function createMap<T>(): MapLike<T> {
  return Object.create(null);
}
