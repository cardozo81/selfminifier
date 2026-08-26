# Arquitetura

## Visão geral

A arquitetura deve preservar a seguinte direção de dependências:

`PowerShell` → `aplicação Node.js` → `núcleo` → `contrato neutro de minificador` → `adaptadores homologados`

Camadas externas podem depender de contratos internos estáveis. O limite entre núcleo e adaptadores é definido em `07-MINIFICACAO-E-MOTORES.md`.

## Responsabilidades conceituais

- **Interface PowerShell:** interação guiada, apresentação do escopo, confirmações e acesso a operações.
- **Aplicação Node.js:** bootstrap, coordenação dos casos de uso e composição dos componentes.
- **Núcleo:** regras independentes de interface e de motor, classificação, planejamento e coordenação da execução.
- **Scanner:** descoberta, normalização e deduplicação de arquivos segundo configuração e regras de seleção.
- **Análise de risco:** combinação do risco do perfil com fatores concretos da execução.
- **Abstração de minificador:** contrato neutro consumido pelo núcleo.
- **Adaptadores:** tradução de intenção funcional para APIs e opções próprias de cada motor homologado.
- **Integridade e recuperação:** hashes, backups, estado técnico, rastreamento de mutações, restauração e rollback.
- **Relatórios:** produção separada de registros técnicos e operacionais.

O contrato do minificador, os perfis e o runtime ficam em `07-MINIFICACAO-E-MOTORES.md`. Configuração persistente pertence a `06-CONFIGURACAO.md`; estado técnico e recuperação pertencem a `08-BACKUP-E-ROLLBACK.md`.

## Limites

- Perfis representam intenção funcional neutra; somente adaptadores a traduzem.
- Preferências do usuário e estado técnico da aplicação são persistências distintas.
- Logs técnicos e relatórios operacionais são produtos distintos.
- Empacotamento local e publicação de GitHub Release são operações separadas.

## Evolução estratégica de compatibilidade

Duas evoluções futuras de compatibilidade são dívidas técnicas estratégicas de mesma prioridade, registradas em `15-DECISOES.md`. Nenhuma faz parte da implementação atual.

```text
STRATEGIC COMPATIBILITY EVOLUTION

DT-MP — Platform compatibility
└── support explicitly qualified platforms without weakening integrity

DT-ME — Engine compatibility
└── support N explicitly homologated adapters without coupling the core
```

- **Evolução de plataforma (DT-MP):** suportar plataformas explicitamente qualificadas sem enfraquecer integridade, recuperação ou garantias fail-closed. Multiplataforma é trabalho futuro; o Windows permanece o suporte atual.
- **Evolução de motores/adaptadores (DT-ME):** suportar N adaptadores explicitamente homologados sem acoplar o núcleo, preservando o contrato neutro de minificador definido em `07-MINIFICACAO-E-MOTORES.md`.

A direção de dependência atual permanece inalterada:

`PowerShell` → `aplicação Node.js` → `núcleo` → `contrato neutro de minificador` → `adaptadores homologados`
