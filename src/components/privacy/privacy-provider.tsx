"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  accountAliases,
  maskAccountName,
  maskText,
  HIDE_ACCOUNT_IDS_KEY,
  HIDE_BALANCES_KEY,
  MASKED_USD,
} from "@/components/privacy/privacy-model";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";

export interface DisplayPrivacy {
  hideAccountIds: boolean;
  hideBalances: boolean;
  setHideAccountIds: (value: boolean) => void;
  setHideBalances: (value: boolean) => void;
  /** A bare account name or id. */
  accountLabel: (nameOrId: string | number | null | undefined) => string;
  /** Free text that may embed an account name or id. */
  text: (s: string) => string;
  /** One formatted balance figure. */
  usd: (formatted: string) => string;
}

const noop = () => {};

/** Everything off: what a component outside the provider (a test) reads. */
const PASS_THROUGH: DisplayPrivacy = {
  hideAccountIds: false,
  hideBalances: false,
  setHideAccountIds: noop,
  setHideBalances: noop,
  accountLabel: (nameOrId) => (nameOrId == null ? "" : String(nameOrId)),
  text: (s) => s,
  usd: (formatted) => formatted,
};

const DisplayPrivacyContext = createContext<DisplayPrivacy>(PASS_THROUGH);

function readFlag(key: string): boolean {
  return localStorage.getItem(key) === "true";
}

function writeFlag(key: string, value: boolean): void {
  if (typeof window !== "undefined") localStorage.setItem(key, String(value));
}

/** Mounted inside `TradingProvider`: the aliases number its full account catalogue. */
export function PrivacyProvider({ children }: { children: React.ReactNode }) {
  const { accounts } = useTrading();
  const [hideAccountIds, setIds] = useState(false);
  const [hideBalances, setBalances] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setIds(readFlag(HIDE_ACCOUNT_IDS_KEY));
    setBalances(readFlag(HIDE_BALANCES_KEY));
  }, []);

  const setHideAccountIds = useCallback((value: boolean) => {
    setIds(value);
    writeFlag(HIDE_ACCOUNT_IDS_KEY, value);
  }, []);
  const setHideBalances = useCallback((value: boolean) => {
    setBalances(value);
    writeFlag(HIDE_BALANCES_KEY, value);
  }, []);

  const aliases = useMemo(() => accountAliases(accounts), [accounts]);

  const value = useMemo<DisplayPrivacy>(
    () => ({
      hideAccountIds,
      hideBalances,
      setHideAccountIds,
      setHideBalances,
      accountLabel: (nameOrId) =>
        maskAccountName(nameOrId == null ? nameOrId : String(nameOrId), aliases, hideAccountIds),
      text: (s) => maskText(s, aliases, hideAccountIds),
      usd: (formatted) => (hideBalances ? MASKED_USD : formatted),
    }),
    [hideAccountIds, hideBalances, setHideAccountIds, setHideBalances, aliases],
  );

  return <DisplayPrivacyContext value={value}>{children}</DisplayPrivacyContext>;
}

export function useDisplayPrivacy(): DisplayPrivacy {
  return useContext(DisplayPrivacyContext);
}
