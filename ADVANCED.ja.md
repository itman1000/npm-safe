# npm-safe Advanced版

この文書は、standard版より詳しい機能や運用上の注意点を説明します。

standard版は意図的に短くしており、基本は `npm install` の代わりに `npm-safe install` を使うだけです。

## 設計目的

`npm-safe` は万能のマルウェアスキャナではありません。目的はもっと狭くしています。

> `npm install` 直後に、改ざんされた依存パッケージのコードが実行され、ローカルの認証情報が漏れるリスクを下げる。

デフォルト設定は、よく使うコマンドを簡単に保ちつつ、install時に悪用されやすい経路を止めることを優先しています。

## デフォルトポリシー

```json
{
  "minAgeDays": 7,
  "ignoreScripts": true,
  "blockGitDependencies": true,
  "blockNonRegistryRemoteTarballs": true,
  "blockFileDependencies": true,
  "sanitizeEnvironment": "simple",
  "strictTarballVerification": false
}
```

## インストール

`npm-safe` は npm 6以上を対応対象にしています。npm 5以前は対応対象外です。

まず1回だけ `npm-safe` をインストールします。

```bash
npm install -g npm-safe --ignore-scripts
```

その後、プロジェクトのディレクトリで使います。

```bash
npm-safe install
npm-safe install axios
npm-safe install -D vitest
```

## コマンド

### install

```bash
npm-safe install
npm-safe install axios
npm-safe install -D vitest
```

内部では、まずnpmに「候補となるlockfile」だけを作らせます。その後、lockfileを検査してから実際のインストールを行います。どちらの段階でもnpmのinstall scriptは実行しません。

### CI

```bash
npm-safe ci
```

`package-lock.json` または `npm-shrinkwrap.json` が必要です。lockfileを検査してから `npm ci --ignore-scripts` を実行します。

### 信頼したパッケージだけrebuildする

```bash
npm-safe rebuild esbuild
npm-safe rebuild sharp
npm-safe rebuild playwright
```

正当にbuild/install scriptが必要なパッケージ向けの逃げ道です。信頼しているパッケージにだけ使ってください。

### 厳格な検証

```bash
npm-safe verify --strict
```

lockfileのポリシー検査を行った後、次を実行します。

```bash
npm audit signatures
```

registry署名検証に対応したnpmが必要です。

## 公開後7日未満のバージョンを止める

デフォルトでは次の方針です。

```text
公開後7日未満のpackage versionはインストールしない。
```

日数を変える例です。

```bash
npm-safe install --min-age=1
npm-safe install --min-age=14
```

1回だけ無効化する例です。

```bash
npm-safe install @your-org/security-fix --allow-new
```

内部実装は次の通りです。

- npm 11.10以降では `--min-release-age=<days>` を使う
- npm 6〜10では `--before=<now - days>` を使う
- npm 5以前では実行せず、npm 6以上への更新を求める
- `npm-safe ci` ではlockfile内の公開日時も直接確認する

npm 5.7以降では一部の機能を実装できる可能性はありますが、lockfileやinstall挙動の検証対象が増えるため、npm-safeでは対応しません。

## registry以外の依存ソース

デフォルトで止めるものです。

```text
git+https://...
github:user/repo
https://example.com/pkg.tgz
file:../local-package
../local-package
```

意図的に使う場合だけ許可します。

```bash
npm-safe install --allow-git
npm-safe install --allow-host cdn.company.example
npm-safe install --allow-remote
npm-safe install --allow-file
npm-safe install --allow-exotic
```

`--allow-host <host>` は、指定した信頼済みhostからのremote tarballだけを許可します。private registryのCDNを使う場合は、まずこちらを使ってください。

`--allow-remote` は、任意のhostからのremote tarball URLを許可します。`--allow-host` では足りない場合だけ使ってください。

`--allow-exotic` は `--allow-git`、`--allow-remote`、`--allow-file` の3つをまとめて許可する省略形です。

## 環境変数の扱い

`npm-safe` は、npmを起動するときに、認証情報を含む可能性が高い環境変数をnpmプロセスへ渡さないようにします。

これは補助的な防御です。主な防御は、依存パッケージのinstall scriptを実行しないことです。

通常、この設定を意識する必要はありません。private registry、proxy、特殊なCI設定を使っている場合だけ、この章を確認してください。

たとえば、次のような名前の環境変数はnpm起動前に除外されます。

```text
*_TOKEN
*_SECRET
*_PASSWORD
*_PRIVATE_KEY
*_CREDENTIAL
*_ACCESS_KEY
*_API_KEY
SSH_AUTH_SOCK
GIT_ASKPASS
SSH_ASKPASS
GIT_SSH_COMMAND
NODE_OPTIONS
```

これは例であり、すべてのsecret名を完全に判定できることを保証するものではありません。

通常は、除外した環境変数の数だけを表示します。

```text
npm-safe: sanitized 3 sensitive environment variable(s)
```

`--verbose` を付けると、除外した変数名を表示します。値は表示しません。

```bash
npm-safe install --verbose
```

出力例です。

```text
npm-safe: sanitized environment variable(s):
  - GITHUB_TOKEN
  - NPM_TOKEN
  - SSH_AUTH_SOCK
```

CIログに変数名を残したくない場合は、`--verbose` を使わないでください。

1回だけ無効化する例です。

```bash
npm-safe install --no-env-sanitize
```

管理された環境でのみ使ってください。

## private registry

registryとは、npmがpackage metadataを問い合わせるサーバーです。通常の公開registryは次です。

```text
https://registry.npmjs.org/
```

会社やチームでは、GitHub Packages、GitLab Package Registry、Artifactory、Nexus Repository、Verdaccio、社内独自registryなどのprivate registryを使うことがあります。

tarballとは、npmパッケージ本体を含む `.tgz` ファイルです。npm installの流れは、おおまかには次のようになります。

```text
1. registryにpackage metadataを問い合わせる
2. metadata内のtarball URLを読む
3. .tgz tarballをダウンロードする
4. node_modulesへ展開する
```

`npm-safe` は、現在のregistry hostと公開npm registry hostからのtarballを許可します。それ以外のremote tarball URLはデフォルトで止めます。

private registryでは、registry hostとtarball hostが別になることがあります。

例:

```text
registry:
  https://npm.company.example/

tarball:
  https://cdn.company.example/packages/foo-1.0.0.tgz
```

このtarball hostが自社または信頼済みのregistry/CDNであることを確認できる場合は、そのhostだけを許可します。

```bash
npm-safe install --allow-host cdn.company.example
```

`--allow-host` にはhost名またはURLを渡せます。URLを渡した場合も、使われるのはhost名だけです。

```bash
npm-safe install --allow-host https://cdn.company.example/packages/
```

`--allow-remote` はregistry外のremote tarball URL全般を許可するため、本当に必要な場合だけ使ってください。

private registryでの推奨方針です。

- install用tokenはread-onlyにする
- publish用tokenをinstall時に使わない
- `.npmrc` ではtokenを対象registry hostにscopeする
- CIでは `npm-safe ci` を使う

## cache

公開日時と検証済みlockfile hashはユーザーのcacheディレクトリに保存します。

```text
~/.cache/npm-safe/
```

同じpackage versionについてregistryへ何度も問い合わせないようにするためです。

## 限界

`npm-safe` はinstall時のリスクを下げる道具です。パッケージが安全であることを証明するものではありません。

完全には防げないものです。

- アプリがimportして実行する悪意あるruntime code
- 公開後7日以上経った悪意あるpackage version
- すでにlockfileに固定され、ポリシー上許可された悪意あるversion
- ユーザーが手動で悪意あるscriptを実行するケース
- `npm-safe` 利用前にすでに漏洩していた認証情報

## CI例

```yaml
name: dependency-install
on: [push, pull_request]

jobs:
  install:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install -g npm-safe --ignore-scripts
      - run: npm-safe ci
      - run: npm-safe verify --strict
```
