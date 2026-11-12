# Como trabalhar no Nimbo

## Branches

- **`main` é o que está no ar** (site e app). Toda branch nova sai dela, e tudo volta para ela por PR.
- Uma branch por tarefa, com prefixo: `feat/` (novidade), `fix/` (correção), `refactor/`, `docs/`, `ci/`.
- Não commite direto na `main`. Depois do merge, apague a branch.

```powershell
git switch main
git pull
git switch -c feat/nome-curto-da-tarefa
# ... trabalha, commita ...
git push -u origin feat/nome-curto-da-tarefa
gh pr create --base main --fill
```

Se a `main` andou enquanto você trabalhava, atualize a sua branch antes de pedir revisão:

```powershell
git fetch origin
git rebase origin/main
git push --force-with-lease
```

## O que é cada parte

| Pasta | O que é | Vai para o pessoal? |
|---|---|---|
| `src/` | Site (React + TypeScript + Vite) | Sim, pelo Firebase Hosting |
| `desktop/main.cjs`, `preload.cjs`, `native/` | App de Windows (Electron) e o capturador de áudio | Sim, pelo Release no GitHub |
| `desktop/rust/` | Experimento do app em Rust | **Não.** Ainda não captura tela; ver `desktop/rust/README.md` |
| `scripts/build-rules.mjs` | Gera `database.rules.json` (não edite o JSON à mão) | Sim, junto com o site |

## Antes de abrir o PR

```powershell
npm run build
npm run test:desktop
npm run test:rules
```

Mexeu em `desktop/rust/`:

```powershell
cargo fmt --manifest-path desktop/rust/Cargo.toml --all -- --check
cargo clippy --manifest-path desktop/rust/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path desktop/rust/Cargo.toml --locked
```

O GitHub Actions roda tudo isso sozinho no PR: **Community validation** (site, testes do app e regras) e
**Rust desktop** (só quando `desktop/rust/` muda, em Windows). PR com check vermelho não entra.

## Publicar (só a partir da `main`)

- **Site e regras:** `npm run build`, depois
  `firebase deploy --project golive-ad118 --only hosting,database`. Regras e site vão sempre juntos.
- **App:** suba a versão em `package.json`, escreva as novidades em `src/lib/changelog.ts`, rode
  `npm run desktop:pack` e crie o Release `vX.Y.Z` no GitHub com `release/Nimbo-Setup.exe`,
  `Nimbo-Setup.exe.blockmap` e `latest.yml`. O app instalado se atualiza sozinho por esse Release.

## Nunca

- Senha, token, chave privada ou credencial de TURN/Cloudflare no código ou em commit.
  A credencial do servidor de retransmissão é colada na aba **Rede** do painel.
- Segurança só escondendo botão no React: quem não pode, tem que ser barrado nas regras do banco.
- Fotos de perfil no Firebase Storage.
