import type { AlertParser } from '../cards.js';
import { linkedin } from './linkedin.js';
import { naukri } from './naukri.js';
import { wellfound } from './wellfound.js';
import { yc } from './yc.js';
import { instahyre } from './instahyre.js';
import { internshala } from './internshala.js';
import { unstop } from './unstop.js';

export const PARSERS: AlertParser[] = [linkedin, naukri, wellfound, yc, instahyre, internshala, unstop];
export const PARSER_IDS = PARSERS.map((p) => p.id) as [string, ...string[]];
export { linkedin, naukri, wellfound, yc, instahyre, internshala, unstop };
