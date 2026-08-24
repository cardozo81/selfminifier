# Regras de negócio

## Seleção de arquivos

O sistema deve aceitar nomes exatos e padrões glob consolidados. Entre os padrões esperados estão:

- `*.js`
- `*.css`
- `custom-*.js`
- `*_portal.css`
- `*menu*.js`
- `**/*.js`
- `**/*.css`
- `modulos/**/custom-*.js`

Deve ser utilizada uma biblioteca de glob madura. Um parser próprio de glob não deve ser criado sem requisito concreto.

São admitidas inclusões e exclusões globais, por origem e temporárias. **Exclusão sempre prevalece sobre inclusão.**

As exclusões técnicas obrigatórias incluem, no mínimo:

- `node_modules`;
- `.git`;
- `_source_versions`;
- o diretório temporário do SelfMinifier em `Dados\Temporarios\`.

Essas exclusões não podem ser desativadas pela configuração do usuário.

Origens sobrepostas devem ser normalizadas e deduplicadas com segurança. Um mesmo arquivo físico não pode ser processado duas vezes na mesma execução.

## Nome de saída no modo `.min`

No modo `PreservarOriginaisECriarMinificados`, `.min` deve ser inserido imediatamente antes da extensão final:

| Origem | Destino |
| --- | --- |
| `app.js` | `app.min.js` |
| `app.module.js` | `app.module.min.js` |
| `site.css` | `site.min.css` |
| `tema.dark.css` | `tema.dark.min.css` |

É proibido gerar nomes como `app.js.min.js` ou `app.min.min.js`. A prevenção de reprocessamento deve considerar a seleção, o destino calculado e as provas de estado definidas em `08-BACKUP-E-ROLLBACK.md`.
