/**
 * Rolling walk-forward geometry, on session-date months.
 *
 * Folds are cut on month boundaries rather than on a rolling day count so
 * two runs over the same range produce the same folds regardless of which
 * weekday `--from` happened to be. The first fold's training window is
 * clamped to `--from`; **a fold whose test window would run past `--to` is
 * not emitted at all**, and is not clamped back to `--to`, because a partial
 * held-out window is a smaller sample wearing a full window's name.
 */
import {
  addMonths,
  firstDayOfMonth,
  lastDayOfMonth,
  monthKeyOf,
} from "./session-dates";

export interface FoldWindow {
  from: string;
  to: string;
}

export interface Fold {
  foldId: number;
  train: FoldWindow;
  test: FoldWindow;
}

export interface BuildFoldsArgs {
  from: string;
  to: string;
  trainMonths: number;
  testMonths: number;
  stepMonths: number;
}

export function buildFolds(args: BuildFoldsArgs): Fold[] {
  const { from, to, trainMonths, testMonths, stepMonths } = args;
  const firstMonth = monthKeyOf(from);

  const folds: Fold[] = [];
  for (let i = 0; ; i++) {
    const trainStartMonth = addMonths(firstMonth, i * stepMonths);
    const testStartMonth = addMonths(trainStartMonth, trainMonths);
    const testEnd = lastDayOfMonth(addMonths(testStartMonth, testMonths - 1));
    if (testEnd > to) break;

    folds.push({
      foldId: folds.length,
      train: {
        from: laterOf(firstDayOfMonth(trainStartMonth), from),
        to: lastDayOfMonth(addMonths(trainStartMonth, trainMonths - 1)),
      },
      test: { from: firstDayOfMonth(testStartMonth), to: testEnd },
    });
  }
  return folds;
}

function laterOf(a: string, b: string): string {
  return a > b ? a : b;
}
