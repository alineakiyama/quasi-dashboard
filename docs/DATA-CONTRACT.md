# Contrato de dados

Tudo que o portal desenha vem dos nove arquivos JSON em `data/`. A interface nunca calcula
um número a partir de outro lugar, e nenhum módulo além de `assets/data.js` lê esses
arquivos.

**A Fase 2 troca o *conteúdo* desses arquivos. Não muda o formato deles, e não encosta na
interface.** Se uma coleta real produzir arquivos que validam contra este documento, o
portal mostra dado real com zero mudança de código.

---

## Regras globais

| Regra | Detalhe |
|---|---|
| Identidade | A loja é **uma só**, então nada é chaveado por loja. O eixo de segmentação é o **motivo do contato**, e toda linha que tem um carrega `reason`. Valores permitidos: os `reason` de `reasons.json`. |
| Timestamps | ISO 8601 **com offset**, ex. `2026-09-04T14:18:00-03:00`. Nunca hora local pelada. |
| Datas | Data ISO de calendário, `YYYY-MM-DD`. Nunca string de exibição como `4 set`. Formatar é trabalho da interface. |
| Durações | **Horas, como número.** `3.75` significa 3h45. Nunca segundo, nunca minuto, nunca `"3h45m"`. |
| Dinheiro | **USD, como número.** `54.9`. Sem símbolo, sem separador de milhar, sem string. |
| Porcentagens | **Nunca armazenadas.** Onde os dois números crus existem, o JSON carrega os dois e o `metrics.js` divide. Os únicos valores em forma de porcentagem nos dados são *alvos* em `meta.json`, que são limiares, não medições. |
| Booleanos | `true` / `false` de verdade, nunca `"true"` / `1` / `"yes"`. |
| Ausente | `null` do JSON, nunca `""`, `0` ou `"N/A"`. `0` quer dizer zero medido. |
| Fechamento do dia | A `date` de uma linha é o dia de calendário no `reporting_timezone` do `meta.json`. A Fase 2 precisa converter os timestamps da API para esse fuso **antes** de agrupar por dia, ou os gráficos diários vão derivar alguns tickets por dia. |

### Por que arrays crus em vez de mediana guardada

`frt_hours` e `resolution_hours` são arrays de **um valor por ticket**, não uma mediana
pré-calculada. Isso é deliberado e sustenta a página inteira:

> Mediana de medianas não é mediana. Se o JSON guardasse `frt_median` por motivo e por dia,
> não haveria jeito correto de produzir a mediana da semana, nem a mediana entre motivos,
> nem a mediana de um recorte qualquer do filtro.

Como os valores crus estão lá, toda mediana da página — do dia, do motivo, da semana, de
qualquer seleção — é calculada sobre o conjunto real de tickets. A mesma razão vale para o
`frt_hours` por atendente em `queue.json`.

O tamanho do array é uma conferência, não enfeite:
`frt_hours.length === answered` e `resolution_hours.length === closed`, em toda linha.

---

## `reasons.json`

O registro dos motivos de contato. Alimenta o filtro, os rótulos e a ordem de exibição.

```json
{ "schema": "reasons/1", "reasons": [ … ] }
```

| Campo | Tipo | Notas |
|---|---|---|
| `reason` | string | Chave primária em todos os outros arquivos. |
| `label` | string | Nome de exibição. É o único lugar onde um rótulo legível de motivo pode morar. |
| `short_label` | string | Versão curta, para onde o espaço é apertado. |
| `color_slot` | inteiro | Reservado. A interface **não** pinta motivo por motivo: as quebras por motivo são barras de uma cor só, ordenadas por magnitude, porque dez matizes distintos não sobrevivem a nenhum teste de daltonismo. O campo existe para o dia em que um subconjunto pequeno precisar de cor. |

A ordem das linhas neste arquivo é a ordem do filtro.

---

## `meta.json`

Limites do período e metas. Editar este arquivo muda o que o portal relata e o que conta
como número bom — sem tocar em código.

| Campo | Tipo | Notas |
|---|---|---|
| `brand` | objeto | `name`, `legal_name`, `site`, `helpdesk`, `ecommerce`, `currency`. Descritivo; nada é agrupado por essas chaves. |
| `generated_at` | timestamp | Quando o dado foi produzido. Aparece na barra lateral, para que um portal desatualizado apareça como desatualizado. |
| `reporting_timezone` | string | Nome IANA. O fuso em que todos os campos `date` são fechados. |
| `data_start` / `data_end` | data | Limites **inclusivos** de tudo que os arquivos cobrem. O seletor não deixa escolher nada fora disso, e os atalhos ("hoje", "ontem", "últimos 30 dias") são contados a partir de `data_end` — não de hoje, porque o dia de ontem só existe nos arquivos depois que o job roda. |
| `period_start` / `period_end` | data | O intervalo com que a página **abre**. Hoje, a última semana fechada. `period_end` também é o dia do retrato de `queue.json`. |
| `targets` | objeto | Chaveado por id de métrica. Ver abaixo. |

**A janela de comparação não é armazenada.** É sempre o intervalo de mesmo tamanho
imediatamente anterior ao escolhido — 7 dias contra os 7 anteriores, agosto contra julho. Se
esse intervalo não couber inteiro dentro de `data_start … data_end`, não há comparação e as
setas de variação somem: comparar contra meio período daria uma seta que parece dizer algo e
não diz.

**Cartões de retrato só valem num intervalo que termina em `period_end`.** Fila e "sem
resposta há +24h" descrevem o instante de `queue.json`. Em qualquer intervalo que termine antes,
a página mostra traço em vez de um número que pareceria pertencer àquele período.

### `targets.<metric_id>`

| Campo | Tipo | Notas |
|---|---|---|
| `label` | string | Rótulo da linha na tabela de metas. |
| `unit` | string | `hours` \| `percent` \| `tickets` \| `usd`. Decide a formatação e o sufixo. |
| `goal` | número | Nesse valor ou melhor ⇒ **na meta**. |
| `warning` | número | Entre `goal` e este ⇒ **atenção**. Além dele ⇒ **fora da meta**. |
| `direction` | string | `lower_is_better` \| `higher_is_better`. Decide de que lado do limiar é bom, **e** a cor de toda variação período a período dessa métrica. Fila caindo é verde porque fila é `lower_is_better`. |

Ids consumidos hoje pela tabela de metas: `frt_median_hours`, `pct_answered_under_24h`,
`resolution_median_hours`, `backlog`, `over_24h_unanswered`, `reopen_rate`, `refund_rate`,
`chargeback_rate`. Remover uma entrada remove a linha; devolver a entrada restaura a linha.

---

## `tickets-daily.json`

Os fatos diários de conversa. **Uma linha por motivo por dia**, cobrindo toda a
janela de `data_start` a `data_end`. É a fonte de todo número de volume,
primeira resposta, resolução e reabertura.

| Campo | Tipo | Notas |
|---|---|---|
| `date` | data | Dia de calendário no fuso do relatório. |
| `reason` | string | O motivo do contato. |
| `created` | inteiro | Conversas nascidas naquele dia. Reportado como contexto; **não** é o número de respondidas. |
| `answered` | inteiro | Conversas que receberam **≥ 1 resposta humana** naquele dia. Resposta automática, macro disparada por automação e mensagem de bot não contam. |
| `closed` | inteiro | Conversas cujo fechamento final aconteceu naquele dia. |
| `reopened` | inteiro | Conversas reabertas naquele dia. O denominador da taxa de reabertura é `closed` na mesma janela. |
| `frt_hours` | número[] | Uma entrada por conversa respondida: horas do nascimento até a primeira resposta humana. Tamanho igual a `answered`. |
| `resolution_hours` | número[] | Uma entrada por conversa fechada: horas do nascimento até o fechamento final. Se foi reaberta e fechada de novo, vale o **último** fechamento. Tamanho igual a `closed`. |

**Casos de borda**

- Uma conversa nascida no domingo e respondida pela primeira vez na segunda conta na
  **segunda** — `answered` é chaveado pela resposta, não pela criação. A entrada dela em
  `frt_hours` vai passar de 24.
- Uma conversa respondida duas vezes no mesmo dia aparece uma vez.
- Uma conversa respondida na segunda e de novo depois de uma reabertura na quinta
  contribui com **uma** entrada em `frt_hours` (a de segunda). A resposta de quinta é
  reabertura, não primeira resposta.
- `created` pode passar de `answered` num dia ruim e ficar abaixo num dia de recuperação.
  Eles não são obrigados a fechar dentro da janela.

---

## `queue.json`

A visão de **retrato** — o estado da fila num instante, mais os números dos atendentes
naquele dia. Nada neste arquivo é soma de dias, e nada nele pode ser somado entre
períodos. `snapshot_at` é o instante que ele descreve.

### `summary`

| Campo | Tipo | Notas |
|---|---|---|
| `backlog` | inteiro | Conversas abertas + pendentes em `snapshot_at`. É uma contagem do que existe, não um total do que aconteceu. |
| `unassigned` | inteiro | Subconjunto do backlog sem responsável. |
| `over_24h_unanswered` | inteiro | Abertas há mais de 24h **e ainda sem resposta humana**. Subconjunto do backlog. Diferente das faixas de idade — um ticket pode ter 30h de vida e já ter sido respondido. |
| `answered_today` | inteiro | Respondidas por humano no dia do retrato. Fecha com `tickets-daily.json` para `date === meta.period_end`. |
| `aging` | objeto | `under_24h`, `h24_to_72h`, `over_72h`. **Precisam somar exatamente `backlog`** — elas o particionam. |
| `oldest_ticket` | objeto | `ticket_id`, `reason`, `subject`, `created_at`, `status`, `assignee_id` (anulável). A idade é calculada contra `snapshot_at`, nunca guardada. |

### `by_reason[]`

Uma linha por motivo: `reason`, `backlog`, `over_24h_unanswered`. Alimenta a barra de fila
por motivo.

### `critical[]`

Uma linha por conversa que precisa de atenção.

| Campo | Tipo | Notas |
|---|---|---|
| `ticket_id`, `reason`, `subject`, `customer`, `order_id` | string | |
| `created_at` | timestamp | Idade = `snapshot_at − created_at`, calculada no `metrics.js`. |
| `first_human_reply_at` | timestamp \| null | `null` quer dizer nunca respondida por gente. Não `""`. |
| `status` | string | `open` \| `pending`. |
| `assignee_id` | string \| null | `null` quer dizer sem responsável. |
| `escalation_reason` | string | Por que está na lista: `no_reply_over_24h`, `waiting_over_3_days`, `reopened`, `refund_requested`, `escalated`. |

### `agents[]`

Uma linha por atendente.

| Campo | Tipo | Notas |
|---|---|---|
| `agent_id`, `agent_name` | string | |
| `answered` | inteiro | No dia do retrato. Somados, dão o `answered_today`. |
| `closed` | inteiro | No dia do retrato. Pode passar de `answered`: fechar uma conversa respondida noutro dia é normal. |
| `reopened` | inteiro | O denominador da taxa de reabertura da pessoa é o `closed` dela. |
| `frt_hours` | número[] | Uma entrada por conversa respondida. Tamanho igual a `answered`. A mediana da pessoa e a contagem de "passou de 24h" saem daqui. |

Reembolsos concedidos por atendente **não** ficam aqui — são contados de `refunds.json`
por `agent_id` no dia do retrato, para que a tabela de atendentes e os cartões de
reembolso não tenham como discordar.

---

## `refunds.json`

**Uma linha por reembolso.** A contagem é o número de linhas — não existe total guardado.
Apagar uma linha muda todo indicador de reembolso da página, sem mudança de código.

| Campo | Tipo | Notas |
|---|---|---|
| `refund_id` | string | Único. |
| `order_id` | string | O pedido Shopify a que o reembolso pertence. |
| `ticket_id` | string \| null | A conversa que levou a ele, quando existe. |
| `refunded_at` | timestamp | Decide em que período o reembolso cai. |
| `amount_usd` | número | O valor efetivamente devolvido — **não** o valor do pedido. Num reembolso parcial, é o valor parcial. |
| `refund_type` | string | `full` \| `partial`. Fatia de parciais = linhas parciais ÷ todas as linhas. |
| `reason` | string | `not_delivered`, `damaged_in_transit`, `quality_issue`, `adverse_reaction`, `late_delivery`, `wrong_item`, `changed_mind`, `subscription_charge`. **Taxonomia própria**, diferente do motivo do contato. |
| `agent_id` | string \| null | Quem concedeu. |

**Taxa de reembolso é `Σ amount_usd ÷ receita da mesma janela`** — dinheiro sobre
dinheiro. Nunca reembolsos ÷ conversas. É para isso que `revenue.json` existe.

---

## `replacements.json`

**Uma linha por reposição enviada.**

| Campo | Tipo | Notas |
|---|---|---|
| `replacement_id` | string | Único. |
| `original_order_id` | string | O pedido que está sendo reposto. |
| `replacement_order_id` | string | O novo envio. |
| `ticket_id` | string \| null | |
| `created_at` | timestamp | Atribuição de período. |
| `supplier_cost_usd` | número | Custo da mercadoria. |
| `shipping_cost_usd` | número | Frete. Custo da reposição = soma dos dois. Ficam separados para o rateio continuar inspecionável. |
| `reason` | string | `not_delivered`, `damaged_in_transit`, `quality_issue`, `wrong_item`, `missing_part`. |
| `is_second_replacement` | booleano | `true` quando é **reposição repetida do mesmo `original_order_id`**. É sinal de qualidade do fornecedor, não de qualidade do atendimento — quer dizer que a própria reposição falhou. |
| `agent_id` | string \| null | |

---

## `revenue.json`

Fatos da Shopify **por dia**: o **denominador da taxa de reembolso** (receita) e o da
**taxa de chargeback** (pedidos).

Linhas diárias, não semanais, porque o período é selecionável: linha semanal não dá
denominador exato para uma janela que não coincide com semanas inteiras.

| Campo | Tipo | Notas |
|---|---|---|
| `date` | data | O dia a que os números pertencem. |
| `revenue_usd` | número | Receita líquida do dia, **antes** de subtrair reembolsos. Subtraí-los primeiro tornaria a taxa de reembolso sem sentido. |
| `orders` | inteiro | Contagem de pedidos do dia. É o denominador da **taxa de chargeback** — sem ele essa taxa não pode ser calculada. |

Nota de Fase 2: este é o único arquivo que não vem do helpdesk. Vem da Shopify. Se o
número da Shopify for pós-reembolso, ele precisa ser reconstituído para bruto antes de
chegar aqui, ou a taxa de reembolso vai sair baixa.

---

## `chargebacks.json`

**Uma linha por disputa.** O envelope também carrega `snapshot_at` — o instante em que a
situação de cada linha era verdade, usado para envelhecer os casos em aberto.

Duas perguntas diferentes são respondidas a partir deste arquivo, e mantê-las separadas é
o ponto:

- **Quantas entraram no período** — recortado por `opened_at`. É a única base da taxa.
- **Onde estão agora** — varredura de todas as linhas, ignorando o período. Uma disputa
  aberta antes da semana e ainda indecisa é dinheiro em risco *hoje*; limitá-la à semana
  seria reportá-la como se tivesse se resolvido sozinha.

| Campo | Tipo | Notas |
|---|---|---|
| `chargeback_id` | string | Único. |
| `order_id` | string | O pedido disputado. |
| `opened_at` | timestamp | Quando a disputa foi levantada. Decide em que período ela conta. |
| `resolved_at` | timestamp \| null | `null` enquanto pendente. Nunca `""`. |
| `amount_usd` | número | O valor disputado. |
| `fee_usd` | número | A taxa por caso do processador. **Cobrada dê no que der e não devolvida numa vitória**, e por isso é somada sobre todas as linhas, não só sobre as perdidas. Omiti-la subestima o custo em uma taxa por caso. |
| `reason` | string | `fraud_unauthorised`, `product_not_received`, `product_not_as_described`, `subscription_not_cancelled`, `duplicate_charge`, `credit_not_processed`, `unrecognised_descriptor`. |
| `status` | string | `open`, `under_review`, `won`, `lost`, `accepted`. |
| `network` | string | `visa`, `mastercard`, `amex`, `paypal`. |
| `represented` | booleano | Se a defesa foi enviada. `false` num caso `accepted`, por definição. |

### O que cada situação quer dizer

| Situação | Significado |
|---|---|
| `open` | Recebida, prazo de resposta correndo. Conta como **pendente**. |
| `under_review` | Defesa enviada, esperando o banco. Conta como **pendente**. |
| `won` | Dinheiro retido. A taxa foi embora do mesmo jeito. |
| `lost` | Dinheiro levado. |
| `accepted` | Não contestada — a escolha deliberada de perder. Somada com `lost` nos totais em dinheiro, e mostrada à parte porque é uma decisão, não um resultado. |

**Aproveitamento é ganhas ÷ decididas**, onde decididas é `won + lost + accepted`. As
pendentes ficam de fora; contá-las rebaixaria a taxa por nenhum motivo além de o tempo
ainda não ter passado.

### A taxa

**Taxa de chargeback é QUANTIDADE ÷ PEDIDOS**, não valor ÷ receita. É a razão que as
bandeiras monitoram e sobre a qual definem limite, então é ela que decide se a loja corre
risco de entrar em programa de monitoramento. A razão em dinheiro é reportada ao lado
porque é o que o problema custa de verdade, mas não é o número que dispara nada.

É por isso que `revenue.json` carrega `orders`. Sem ele não há denominador e a taxa não
pode ser calculada.

Os limiares vivem em `meta.json` sob `targets.chargeback_rate` — `goal` é o nível em que
uma conta saudável fica e `warning` está posto onde os programas de monitoramento
costumam começar.

---

## `action-plans.json`

**Uma linha por plano de ação.** Este arquivo é o conteúdo inteiro da tela Planos de ação:
acrescentar um plano, reescrever um passo, marcar um como feito, atribuir responsável ou
mudar prioridade acontece aqui, nunca em código.

Diferente de todos os outros, **não** é produzido pelo gerador. É escrito à mão e não está
preso a um período de relatório — um plano fica aberto até ser fechado.

| Campo | Tipo | Notas |
|---|---|---|
| `plan_id` | string | Único e estável. |
| `title` | string | Nome curto do problema. |
| `problem` | string | O que o cliente sente, em português claro. |
| `why_it_matters` | string \| null | Por que este merece atenção antes dos outros — custo, risco ou volume. Opcional; linhas sem ele simplesmente não desenham o bloco. |
| `priority` | inteiro | `1` é o mais alto. Os planos aparecem nesta ordem. |
| `status` | string | `not_started` \| `in_progress` \| `blocked` \| `done`. Qualquer outro valor vira um chip "desconhecido" em vez de quebrar. |
| `owner` | string \| null | `null` desenha "Sem responsável definido" — deliberadamente visível em vez de em branco. |
| `opened_at` | data | Quando o plano foi registrado. |
| `metric` | string \| null | Como alguém vai saber que funcionou. Um plano sem métrica é um desejo. |
| `actions` | array | Os passos, na ordem mostrada. |

### `actions[]`

| Campo | Tipo | Notas |
|---|---|---|
| `text` | string | Um passo concreto. |
| `type` | string | Quem precisa se mexer: `supplier`, `tech`, `comms`, `policy`, `internal`. Vira uma etiqueta pequena; valor não reconhecido desenha sem etiqueta. |
| `done` | booleano | `true`/`false` de verdade. Alimenta o pontinho preenchido e a contagem "N de M passos" no cabeçalho. Os pontinhos são só leitura — o avanço é registrado editando este arquivo, não clicando. |

**Casos de borda**

- Sem nenhuma linha, a tela desenha um "Nenhum plano registrado" explícito, não uma página
  vazia — para uma aba vazia nunca ser confundida com uma aba quebrada.
- A tela ignora o seletor de período. Planos não pertencem a uma semana.

---

## Invariantes de consistência

Os dados fictícios satisfazem todos estes, e qualquer coleta da Fase 2 também precisa.
Vale afirmá-los dentro do job que escreve os arquivos.

1. `frt_hours.length === answered` e `resolution_hours.length === closed` em todas as linhas de
   `tickets-daily.json`.
2. `aging.under_24h + aging.h24_to_72h + aging.over_72h === backlog` em `queue.json`.
3. `Σ agents[].answered === summary.answered_today`, e a união dos `frt_hours` dos
   atendentes é exatamente o conjunto de `frt_hours` de `meta.period_end`.
4. Todo `reason` de todo arquivo aparece em `reasons.json`.
5. Todo `refunded_at` / `created_at` cai dentro de `data_start … data_end`.
   (`chargebacks.json` é a exceção deliberada: ele carrega casos mais antigos ainda vivos.)
6. `revenue.json` tem uma linha por dia, de `data_start` a `data_end`, sem buraco.
7. Os cartões da semana são iguais à agregação dos arrays diários; a linha
   "Total / ponderado" da tabela por motivo é igual à mesma agregação. Nenhum dos dois está
   guardado em lugar nenhum.

Os itens 1, 2, 3 e 4 são conferidos pela própria página ao carregar — quando falham, ela
escreve um aviso específico no console e mostra uma tarja vermelha abaixo dos filtros, e
renderiza mesmo assim.
