import { flags as oclifFlags } from "@oclif/command";
import { IConditions, recordHARClient } from "@tracerbench/core";
import type { Archive } from "@tracerbench/har";
import { mkdirpSync, readJson, writeFileSync, writeJsonSync } from "fs-extra";
import { join, resolve } from "path";
import Protocol from "devtools-protocol";

import { getConfig, TBBaseCommand } from "../../command-config";
import { headlessFlags } from "../../command-config/default-flag-args";
import {
  config,
  cookiespath,
  dest,
  filename,
  headless,
  marker,
  proxy,
  screenshots,
  tbResultsFolder,
  url,
} from "../../helpers/flags";

export default class RecordHAR extends TBBaseCommand {
  public static description = "Generates a HAR file from a URL";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public static flags: oclifFlags.Input<any> = {
    url: url({ required: true, default: undefined }),
    dest: dest({ required: true }),
    cookiespath: cookiespath({ required: true }),
    filename: filename({ required: true, default: "tracerbench" }),
    marker: marker({ required: true }),
    config: config(),
    headless,
    screenshots,
    proxy: proxy(),
    tbResultsFolder: tbResultsFolder(),
  };
  public async init(): Promise<void> {
    const { flags } = this.parse(RecordHAR);
    this.parsedConfig = getConfig(flags.config, flags, this.explicitFlags);
  }

  public async run(): Promise<void> {
    const { flags } = this.parse(RecordHAR);
    const { url, dest, cookiespath, filename, marker, screenshots, proxy } =
      flags;
    const { network, cpuThrottleRate, headless, tbResultsFolder } =
      this.parsedConfig;
    // getConfig will always return defaultFlagArgs
    const resultsDir = tbResultsFolder as string;
    let { browserArgs } = this.parsedConfig;
    const conditions: IConditions = {
      network: network ? network : "none",
      cpu: cpuThrottleRate ? parseInt(cpuThrottleRate as string, 10) : 1,
    };
    let cookies: Protocol.Network.CookieParam[] = [];

    // results folder
    mkdirpSync(resultsDir);
    // har dest folder (usecase when not identical)
    mkdirpSync(dest);

    if (cookiespath.length) {
      // grab the auth cookies
      const resolvedPath = resolve(cookiespath);
      const rawCookies:
        | Protocol.Network.CookieParam[]
        | { cookies: Protocol.Network.CookieParam[] } = await readJson(
        resolvedPath
      );
      if (rawCookies && "cookies" in rawCookies) {
        cookies = rawCookies.cookies as Protocol.Network.CookieParam[];
      } else {
        cookies = rawCookies as Protocol.Network.CookieParam[];
      }
      if (!Array.isArray(cookies)) {
        throw `Incorrect cookie file format (${resolvedPath}), should be [ {name: "foo", value: "boo" } ]`;
      }
    }

    // if headless flag is true include the headless flags
    if (headless) {
      browserArgs = Array.isArray(browserArgs)
        ? browserArgs.concat(headlessFlags)
        : headlessFlags;
    }

    // if using a proxy server include the chrome switch with proxy url
    if (proxy) {
      const proxyServer = [`--proxy-server=https=${proxy}`];
      browserArgs = Array.isArray(browserArgs)
        ? browserArgs.concat(proxyServer)
        : proxyServer;
    }

    this.log(`Recording HAR ...`);
    // record the actual HAR and return the archive file
    const harArchiveResponse = await recordHARClient(
      url,
      cookies,
      marker,
      conditions,
      headless,
      browserArgs,
      screenshots
    );

    if (screenshots && harArchiveResponse.screenshotData) {
      harArchiveResponse.screenshotData.map((screenshot) => {
        const screenshotName = `record-har-${screenshot.name}-screenshot.png`;
        const screenshotPath = resolve(join(resultsDir, screenshotName));

        writeFileSync(screenshotPath, screenshot.data, {
          encoding: "base64",
        });

        this.log(`  ✔ ${screenshot.name} screenshot: ${screenshotPath}`);
      });
    }

    const harPath = join(dest, `${filename}.har`);

    // validate the har file can be parsed as JSON
    // validate that the expected URL matches what was recorded
    await this.validateHAR(harArchiveResponse.archive, url);

    writeJsonSync(harPath, harArchiveResponse.archive);

    this.log(`  ✔ HAR recorded: ${harPath}`);
  }

  public async validateHAR(harJSON: Archive, url: string): Promise<void> {
    this.log(`Validating HAR ...`);

    try {
      const harFileURL = this.getURLfromHAR(harJSON);
      if (harFileURL !== url) {
        this.log(`  ! Expected: ${url}`);
        this.log(`  ! Actual: ${harFileURL}`);
        throw `The HAR was recorded with a different URL than expected. Expected and Actual should match.`;
      }
    } catch (error) {
      this.error(`  ✖ HAR file invalid. ${error}`);
    }
  }

  public getURLfromHAR(harJSON: Archive): string {
    try {
      const url = harJSON.log.entries[0].request.url;
      return url;
    } catch (error) {
      this.error(`\nCould not extract the URL from the HAR.\n${error}`);
    }
  }
}
