# Crossfire Trading

A self-hosted web app that runs automated futures strategies against your own
broker account. It places bracketed orders (entry, stop and target together),
manages open positions, streams market data, and shows everything on a
dashboard. It also backtests strategies on historical 1-minute bars.

Supported brokers: **Topstep** (through the ProjectX API) and **Tradovate**.
Historical data for backtests comes from **Databento**.

## Read this first

- **This is not financial advice.** Nothing in this repository recommends
  trading anything. The three strategies it ships are code examples, not
  strategies with an edge; the author's own strategies are not included.
- **Automated trading loses money fast when something goes wrong** — a bug, a
  dropped connection, a broker outage, a setting you misread. You are
  responsible for every order this software places on your account.
- **Start on a practice or simulated account and stay there** until you have
  watched it trade for a long time and understand what it does. The default
  build only auto-trades practice accounts.
- **Check your broker's and prop firm's rules on automated trading yourself.**
  Topstep does not permit it on live funded accounts. In a `prod` build the app
  refuses any Topstep account it does not recognise as practice (`PRAC-`),
  Trading Combine (`50KTC-` and other sizes) or ExpressFunded (`EXPRESS-`) —
  but it does auto-trade ExpressFunded, which is a funded account, and
  Tradovate accounts on Tradovate's live server. That is the author's reading
  of the rules, not a guarantee; do not rely on it to keep you inside them.
- **The app has no login of its own.** Anyone who can open it in a browser can
  trade the accounts you configure. Run it on your own machine; the start
  script listens on `localhost` only.
- Provided as is, with no warranty. See [LICENSE](LICENSE).

## What you need

- **Node.js 22** or newer, with Corepack (it ships with Node). Nothing else
  is installed globally.
- A Topstep account with ProjectX API access (an API key from your account's
  API settings — Topstep may charge for it), and/or a Tradovate account with
  API access. Each user brings their own; nothing here works without one.
- For backtests only: a [Databento](https://databento.com) account and API key
  (downloads are billed per use).

## Run it

```sh
git clone https://github.com/dramos126/crossfire-trading-futures.git
cd crossfire-trading-futures
./start.sh
```

The script checks for Node, creates `.env.local` from the example if you have
none, installs the dependencies, builds the app and starts it on
<http://localhost:3000>. Ctrl-C stops it; run it again after pulling new code.
`./start.sh --dev` runs the development server instead, which rebuilds as you
edit.

The same thing by hand, which also works on Windows:

```sh
corepack yarn install --frozen-lockfile
cp .env.example .env.local        # optional
corepack yarn build
corepack yarn start -H 127.0.0.1  # or: corepack yarn dev -H 127.0.0.1
```

Use `corepack yarn`, not `npm` or a globally installed `yarn`: the repo pins
Yarn 1 and its lockfile. The database is created at `./data/trading.db`.

Checks:

```sh
corepack yarn tsc --noEmit   # type-check
corepack yarn test           # unit tests
corepack yarn build          # production build
```

## Configuration

Every variable in [.env.example](.env.example) is optional and explained
there. Broker credentials are normally **not** put in this file: you enter them
in the browser on first run, and they are stored in the local SQLite database.
The ones that matter most:

| Variable | What it does |
|---|---|
| `NEXT_PUBLIC_APP_ENV` | `staging` (default): auto-trading is limited to practice accounts and Tradovate uses its demo server. `prod`: Tradovate's live server, and the Topstep Combine and ExpressFunded accounts described above become tradable. Fixed when the app is built — rebuild after changing it. |
| `TRADING_DB_PATH` | Where the database lives. Default `./data/trading.db`. |
| `USE_REALTIME_BARS` | `true` builds bars from the live trade stream; otherwise bars are polled every 30 seconds. |
| `TRADE_NOTIFIER_WEBHOOK_URL` | A Discord webhook for trade and alert messages. |
| `DATABENTO_API_KEY`, `BAR_CACHE_DIR`, `BACKTEST_ARTIFACTS_DIR` | Historical data and backtest output (see [Backtests](#backtests)). |

## First run

1. Open the app. With no broker configured it opens **Settings**.
2. Enter your Topstep username and API key and/or your Tradovate credentials,
   and test the connection. They are stored in the local database.
3. Your accounts appear on the **Dashboard**. Each is marked practice or live;
   in the default `staging` build only practice accounts can be auto-traded.
4. Open **Books**. The **Sample** book is there with no account on it; *Deploy
   Sample to an account* puts a practice account on it, with each of its three
   playbooks as a switch you can turn on or off. Set the account's risk per
   trade on its Risk page. The engine starts managing it from the next bar.
5. Or open **Playbooks**, pick one strategy, and deploy it on its own with
   your own settings.

## Strategies and books

Strategies ("playbooks" in the app) are TypeScript modules under
[`src/lib/trading/strategies/`](src/lib/trading/strategies/). Each is one
`<name>/<name>.strategy.ts` file that declares its settings, the indicators it
needs, when to enter (with its stop and target) and when to exit; the file name
is its key. This copy ships three, all on 5-minute MNQ bars and all built on
moving averages, as examples of the module shape:

| Key | What it does |
|---|---|
| [`bar-close-pulse`](src/lib/trading/strategies/prod/ema/bar-close-pulse/bar-close-pulse.strategy.ts) | A two-bar continuation entry in the direction of the EMA stack. |
| [`ema-crossover`](src/lib/trading/strategies/prod/ema/ema-crossover/ema-crossover.strategy.ts) | Enters when a fast EMA crosses a slow one. |
| [`trend-follower`](src/lib/trading/strategies/prod/ema/trend-follower/trend-follower.strategy.ts) | A pullback entry in an established EMA trend, with a test file beside it. |

None of them has an edge in the author's testing. They are here so you can
see how a module is written, run a backtest, and watch the engine manage a
position on a practice account.

A build registers every module under `prod/`; the keys it expects are listed
in [`prod-playbooks.ts`](src/lib/trading/strategies/prod-playbooks.ts), and the
app reports at boot if the two disagree. A `staging` build also registers
modules under `staging/` and `test/` (empty here). To add your own, copy one of
the three into a new folder under `prod/` and add its key to the list.

A **book** is a named set of playbooks on contracts, defined in code in
[`code-books.ts`](src/lib/trading/books/code-books.ts), that an account runs
as one unit. The **Sample** book holds the three example playbooks on MNQ.
Changing a book is a code change; the Books page shows what each book carries
and which accounts run it.

## Backtests

Backtests replay a strategy over historical 1-minute bars kept in a local
Parquet cache. Fill the cache from Databento (this costs money; `--dry-run`
prints the plan and the estimated cost first):

```sh
# in .env.local: DATABENTO_API_KEY=... and BAR_CACHE_DIR=./data/bar-cache
corepack yarn backfill:databento --symbols MNQ.c.0 --from 2024-01-01 --to 2024-12-31 --dry-run
corepack yarn backfill:databento --symbols MNQ.c.0 --from 2024-01-01 --to 2024-12-31
```

Then run one:

```sh
corepack yarn backtest run --playbook bar-close-pulse --ticker MNQ --timeframe 5m \
  --from 2024-06-03 --to 2024-06-28
```

It prints the folder it wrote the run to; the app's **Saved Runs** panel reads
the same folder (`BACKTEST_ARTIFACTS_DIR`). A backtest is a model of the past,
not a forecast: fills, slippage and fees in live trading differ.

## Notes

- This repository is a copy of a private one, exported without its history,
  documentation or the author's own strategies. Code comments refer to design
  notes under `docs/` that are not part of this copy.
- Every push is scanned for committed secrets by
  [gitleaks](https://github.com/gitleaks/gitleaks); `.gitleaks.toml` holds the
  two allowances it needs.

## License

[PolyForm Noncommercial 1.0.0](LICENSE): free to use, change and share for
noncommercial purposes.
