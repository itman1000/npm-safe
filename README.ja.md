# @itman1000/npm-safe

`npm-safe` は、`npm install` を安全寄りに実行する小さなラッパーです。npm 6以上に対応しています。

## standard版

まず1回だけインストールします。

```bash
npm install -g @itman1000/npm-safe --ignore-scripts
```

その後は、`npm install` の代わりに `npm-safe install` を使います。

```bash
npm-safe install
npm-safe install axios
npm-safe install -D vitest
```

デフォルトで行うことは次の4つです。

- 公開後7日未満のパッケージバージョンを止める
- npmのinstall scriptを実行しない
- git依存、registry外のtarball URL、ローカルの `file:` 依存を止める
- npm起動前に、機密情報っぽい環境変数を軽く除外する

## なぜnpm-safeを使うのか

`pnpm` へ移行できるプロジェクトでは、pnpmも強力な選択肢です。`npm-safe` は、npm、`package-lock.json`、npm 6以降との互換性を保ったまま、安全寄りのinstallを使いたいプロジェクト向けです。

| 比較項目 | `npm install` | 最近のpnpmまたは保護設定済みの `pnpm install` | `npm-safe install` |
| --- | --- | --- | --- |
| 既存の `package-lock.json` を使える | はい | いいえ。`pnpm-lock.yaml` を使う | はい |
| 依存パッケージのinstall scriptをデフォルトで止める | いいえ | はい。build承認・保護設定を使う | はい |
| 公開直後の新しすぎるバージョンを避ける | 新しいnpmでは手動設定が必要 | 最近のpnpmでは組み込み・設定可能 | はい。npm 6以降でも7日遅延がデフォルト |
| git依存、remote tarball、`file:` 依存を止める | 新しいnpmでは手動設定が必要 | 最近のpnpmでは強い制御がある | はい。デフォルトで止める |
| tokenらしい環境変数をnpm起動前に除外する | いいえ | いいえ | はい。軽量に除外する |
| 主なトレードオフ | 速くて慣れているが、防御は少ない | 強力だがpnpm移行が必要 | npmより少し遅いが、移行不要 |

信頼できるパッケージでbuild scriptが必要な場合だけ、個別に実行します。

```bash
npm-safe rebuild esbuild
```

CI、例外指定、厳格な検証、private registryについては [ADVANCED.ja.md](./ADVANCED.ja.md) を読んでください。
