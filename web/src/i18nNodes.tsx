import { Fragment, type ReactNode } from 'react';
import { t } from './i18n.ts';

/**
 * t() for a sentence with elements in it (a <code>, a <b>, a link): the sentence is translated whole, so each
 * language can put the elements where its word order wants them, and {0}, {1}, … become the arguments.
 */
export function tj(ko: string, ...args: ReactNode[]): ReactNode {
  return t(ko)
    .split(/\{(\d+)\}/)
    .map((part, i) => <Fragment key={i}>{i % 2 ? args[Number(part)] : part}</Fragment>);
}
