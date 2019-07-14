import * as Handlebars from 'handlebars';
import * as path from 'path';
import { convertMicrosecondsToMS } from './utils';
import { Stats } from './statistics/stats';
import { readFileSync } from 'fs-extra';
import { defaultFlagArgs } from '../command-config/default-flag-args';
import { ITBConfig } from '../command-config';

export interface Sample {
  duration: number;
  js: number;
  phases: Array<{
    phase: string;
    start: number;
    duration: number;
  }>;
  gc: any;
  blinkGC: any;
  runtimeCallStats: any;
}

export interface ITracerBenchTraceResult {
  meta: {
    browserVersion: string;
    cpus: string[];
  };
  samples: Sample[];
  set: string;
}

interface HTMLSectionRenderData {
  isSignificant: boolean;
  ciMin: number;
  ciMax: number;
  hlDiff: number;
  phase: string;
  identifierHash: string;
  controlSamples: string;
  experimentSamples: string;
  servers: any;
  shouldPageBreak: boolean;
}

const PAGE_LOAD_TIME = 'duration';

const CHART_CSS_PATH = path.join(__dirname, '../static/chart-bootstrap.css');
const CHART_JS_PATH = path.join(
  __dirname,
  '../static/chartjs-2.8.0-chart.min.js',
);
const REPORT_PATH = path.join(__dirname, '../static/report-template.hbs');

const CHART_CSS = readFileSync(CHART_CSS_PATH, 'utf8');
const CHART_JS = readFileSync(CHART_JS_PATH, 'utf8');
let REPORT_TEMPLATE_RAW = readFileSync(REPORT_PATH, 'utf8');

REPORT_TEMPLATE_RAW = REPORT_TEMPLATE_RAW.toString()
  .replace(
    '{{!-- TRACERBENCH-CHART-BOOTSTRAP.CSS --}}',
    `<style>${CHART_CSS}</style>`,
  )
  .replace('{{!-- TRACERBENCH-CHART-JS --}}', `<script>${CHART_JS}</script>`);


/**
 * Extract the phases and page load time latency into sorted buckets by phase
 *
 * @param samples - Array of "sample" objects
 * @param valueGen - Calls this function to extract the value from the phase. A "phase" is passed containing duration and start
 */
export function bucketPhaseValues(samples: Sample[], valueGen: any = (a: any) => a.duration): { [key: string]: number[] } {
  const buckets: { [key: string]: number[] } = { [PAGE_LOAD_TIME]: [] };

  samples.forEach((sample: Sample) => {
    buckets[PAGE_LOAD_TIME].push(sample[PAGE_LOAD_TIME]);
    sample.phases.forEach(phaseData => {
      const bucket = buckets[phaseData.phase] || [];
      bucket.push(valueGen(phaseData));
      buckets[phaseData.phase] = bucket;
    });
  });

  Object.keys(buckets).forEach(phase => {
    buckets[phase].sort();
  });

  return buckets;
}

/**
 * Override the default server and plot title attributes
 *
 * @param tbConfig - Concerned only about the "servers" and "plotTitle" attribute
 */
export function resolveTitles(tbConfig: Partial<ITBConfig>) {
  const reportTitles = {
    servers: [{ name: 'Control' }, { name: 'Experiment' }],
    plotTitle: defaultFlagArgs.plotTitle,
  };

  if (tbConfig.servers) {
    reportTitles.servers = tbConfig.servers as any;
    reportTitles.servers = reportTitles.servers.map((titleConfig, idx) => {
      if (idx === 0) {
        return {name: `Control: ${titleConfig.name}`};
      } else {
        return {name: `Experiment: ${titleConfig.name}`};
      }
    }) as any;
  }

  if (tbConfig.plotTitle) {
    reportTitles.plotTitle = tbConfig.plotTitle;
  }

  return reportTitles;
}

/**
 * Generate the HTML render data for the cumulative chart. Ensure to convert to milliseconds for presentation
 *
 * @param controlData - Samples of the benchmark of control server
 * @param experimentData - Samples of the benchmark experiment server
 */
export function buildCumulativeChartData(controlData: ITracerBenchTraceResult, experimentData: ITracerBenchTraceResult) {
  const cumulativeValueFunc = (a: any) => convertMicrosecondsToMS(a.start + a.duration);
  const valuesByPhaseControl = bucketPhaseValues(controlData.samples, cumulativeValueFunc);
  const valuesByPhaseExperiment = bucketPhaseValues(experimentData.samples, cumulativeValueFunc);
  const phases = Object.keys(valuesByPhaseControl).filter((k) => k !== PAGE_LOAD_TIME);

  return {
    categories: JSON.stringify(phases),
    controlData: JSON.stringify(phases.map((k) => valuesByPhaseControl[k])),
    experimentData: JSON.stringify(phases.map((k) => valuesByPhaseExperiment[k])),
  };
}

export default function createConsumeableHTML(
  controlData: ITracerBenchTraceResult,
  experimentData: ITracerBenchTraceResult,
  tbConfig: ITBConfig,
): string {
  const valuesByPhaseControl = bucketPhaseValues(controlData.samples);
  const valuesByPhaseExperiment = bucketPhaseValues(experimentData.samples);
  const phases = Object.keys(valuesByPhaseControl);
  const sectionFormattedData: HTMLSectionRenderData[] = [];
  const reportTitles = resolveTitles(tbConfig);

  phases.forEach(phase => {
    const controlValues = valuesByPhaseControl[phase];
    const experimentValues = valuesByPhaseExperiment[phase];
    const stats = new Stats({
      control: controlValues,
      experiment: experimentValues,
      name: 'output',
    });
    const isNotSignificant =
      (stats.confidenceInterval.min < 0 && 0 < stats.confidenceInterval.max) ||
      (stats.confidenceInterval.min > 0 && 0 > stats.confidenceInterval.max) ||
      (stats.confidenceInterval.min === 0 && stats.confidenceInterval.max === 0);

    sectionFormattedData.push({
      phase,
      identifierHash: phase,
      isSignificant: !isNotSignificant,
      // Ensure to convert to milliseconds for presentation
      controlSamples: JSON.stringify(controlValues.map((val) => convertMicrosecondsToMS(val))),
      experimentSamples: JSON.stringify(experimentValues.map((val) => convertMicrosecondsToMS(val))),
      ciMin: stats.confidenceInterval.min,
      ciMax: stats.confidenceInterval.max,
      hlDiff: stats.estimator,
      servers: reportTitles.servers,
      shouldPageBreak: phase === 'duration',
    });
  });

  Handlebars.registerHelper('toCamel', val => {
    return val.replace(/-([a-z])/g, (g: string) => g[1].toUpperCase());
  });

  /**
   * Negative means slower
   */
  Handlebars.registerHelper('isFaster', analysis => {
   return analysis.hlDiff > 0;
  });

  /**
   * Absolute number helper
   */
  Handlebars.registerHelper('abs', num => {
   return Math.abs(num);
  });

  const template = Handlebars.compile(REPORT_TEMPLATE_RAW);

  return template({
    cumulativeChartData: buildCumulativeChartData(controlData, experimentData),
    reportTitles,
    sectionFormattedData,
    sectionFormattedDataJson: JSON.stringify(sectionFormattedData)
  });
}
