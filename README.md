# Portal Quasi — Atendimento

> ### ⚠️ Isto é uma demonstração
>
> **Peça de portfólio. Não tem vínculo com a Quasi e não é um relatório da empresa.**
>
> Todos os números aqui — conversas, tempos de resposta, reembolsos, chargebacks, receita,
> nomes de clientes, nomes de atendentes, números de pedido — são **inventados**. Saíram de
> um script gerador (`tools/generate-data.ps1`) com semente fixa. Nenhum dado real de
> cliente, pedido ou atendimento foi usado.
>
> O que é real é o *formato*: as definições das métricas, a matemática e a arquitetura, que
> foram feitas para receber dado verdadeiro sem mudar a interface.
>
> As cores e a tipografia foram tiradas do CSS público do site da marca, apenas para o
> exercício ficar visualmente coerente.

Relatório semanal de atendimento ao cliente da **Quasi**, uma loja só, atendida pelo
**Commslayer** sobre **Shopify**. Cinco telas: a visão do cliente, a operação interna,
chargebacks, os planos de melhoria e a explicação de onde cada número sai.

Site estático. HTML, CSS e módulos ES puros. Sem framework, sem bundler, sem etapa de
build, sem dependência. O GitHub Pages serve o repositório exatamente como ele está.

> **Todos os números desta página são fictícios.** São plausíveis e batem entre si, mas
> foram gerados, não medidos. O que é real aqui é o *formato*, as definições e a
> matemática — veja [Fase 2](#fase-2-dado-real).

---

## Rodar localmente

O site precisa ser servido por HTTP. **Abrir o `index.html` com dois cliques não
funciona** — o navegador bloqueia módulos ES e `fetch()` em `file://`, então a página
carrega a casca e mostra erro de dados. É regra de segurança do navegador, não coisa que
o código consiga contornar.

Qualquer servidor estático resolve. Em ordem de "o que você provavelmente já tem":

```bash
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Não precisa de nada instalado — o `serve.ps1` é um arquivo PowerShell de ~70 linhas que
existe neste repositório exatamente para isso. Serve a raiz na porta 8124 (`-Port 9000`
para trocar).

Com Node ou Python:

```bash
npx serve -l 8124
```

```bash
python -m http.server 8124
```

Depois abra **<http://localhost:8124/>**. Ctrl+C para parar.

---

## O que você está vendo

| Tela | Para quem | Conteúdo |
|---|---|---|
| **Visão da semana** | O cliente | Cartões de destaque, volume por dia, tempo de primeira resposta, quebra por motivo de contato, reembolsos, reposições, metas |
| **Operação** | O time de suporte | A fila agora, idade do backlog, fila crítica, números por atendente |
| **Chargebacks** | Os dois | Taxa sobre pedidos, o que está parado no banco, ganhos e perdidos em quantidade e valor |
| **Planos de ação** | Os dois | O que foi combinado para melhorar, com a métrica que vai julgar cada plano |
| **De onde vêm os números** | Os dois | O que cada métrica mede, as convenções e os três jeitos de alimentar isto |

### O seletor de período

Os dados fictícios cobrem 18 semanas (4/mai a 6/set de 2026). O seletor no topo oferece
cinco atalhos de um clique — hoje, ontem, últimos 7, 30 e 60 dias — e um intervalo livre
com duas datas ("Custom range"), para qualquer recorte como do dia 7 ao dia 12.

Com um dia só (hoje, ontem, ou um intervalo livre de um dia), os gráficos de tendência dão
lugar aos números do dia: os dados são diários, não por hora, e uma linha de um ponto não
diz nada.

- **Os atalhos contam a partir do último dia com dado, não de hoje.** Dado de ontem só
  existe depois que o job roda; contar a partir de hoje incluiria dias vazios.
- **A comparação é sempre contra o intervalo de mesmo tamanho imediatamente anterior** —
  7 dias contra os 7 anteriores, agosto contra julho. Se esse intervalo não couber inteiro
  nos dados, as setas de variação somem, em vez de comparar contra meio período.
- **Acima de 31 dias os gráficos passam a um ponto por semana**, com a mediana recalculada
  sobre os tickets reunidos da semana. Semanas cortadas pelo intervalo avisam no tooltip
  quantos dias têm.
- **Fila e "sem resposta há +24h" são retrato do último dia.** Num intervalo que termina
  antes dele, esses cartões mostram traço em vez de um número que pareceria daquele período.

### O eixo de comparação é o motivo do contato

É a diferença estrutural em relação a um portal multi-loja. Com uma loja só não existe
"comparar lojas", então o eixo passa a ser **por que a pessoa escreveu**: rastreio,
entrega, assinatura, dúvida, reembolso, cancelamento, reação na pele, produto danificado,
item errado, cupom.

O filtro no topo recalcula todos os cartões, gráficos e tabelas das telas Visão da semana
e Operação. Nada é pré-calculado por seleção — escolher um motivo roda as mesmas funções
de agregação sobre um conjunto menor de linhas.

Três blocos ignoram esse filtro de propósito, e a tela avisa quando isso acontece:

- **A tabela "Por que as pessoas escrevem"**, porque ela *é* a comparação entre motivos.
- **Reembolsos, reposições e chargebacks**, porque essas linhas não carregam motivo de
  contato — elas têm a própria taxonomia. Um reembolso sabe que foi por "não entregue";
  não sabe qual conversa o originou como motivo.
- **A tela Operação inteira**, que é um retrato de um instante e por isso não responde ao
  seletor de período.

---

## Mexer nos dados

Os nove arquivos ficam em `data/`. Edite e recarregue — não há nada para reconstruir.

O portal é genuinamente orientado a dados, então isso funciona do jeito que você
esperaria:

- **Apague uma linha de `data/refunds.json`** → a contagem, o total devolvido, a taxa de
  reembolso, a fatia de parciais e a quebra por motivo se movem. Sem tocar em código.
- **Mude um alvo em `data/meta.json`** → os chips da tabela de metas mudam. Tire uma
  entrada inteira e a linha some; devolva e ela volta.
- **Mude `period_start` / `period_end`** → muda o intervalo com que o portal **abre**.
  Qualquer outro continua a um clique no seletor de período. Já `data_start` / `data_end`
  precisam descrever o que os arquivos realmente cobrem — são eles que limitam o seletor.

Duas coisas precisam continuar verdadeiras, ou os números param de concordar entre si:

1. Em `tickets-daily.json`, `frt_hours` precisa ter exatamente `answered` entradas e
   `resolution_hours` exatamente `closed`.
2. Em `queue.json`, as três faixas de `aging` precisam somar exatamente o `backlog`.

A página confere as duas ao carregar, escreve um aviso específico no console do navegador
e mostra uma tarja vermelha abaixo da barra de filtros. Ela renderiza mesmo assim — um
feed meio quebrado ainda mostra o que dá.

**O esquema completo está em [`docs/DATA-CONTRACT.md`](docs/DATA-CONTRACT.md)** — cada
campo, sua unidade e os casos de borda. Leia antes de mudar o *formato* de um arquivo, em
vez de só os valores.

### Regerar tudo do zero

```bash
powershell -ExecutionPolicy Bypass -File tools/generate-data.ps1
```

Escreve oito dos nove arquivos (o `action-plans.json` é escrito à mão e não sai do
gerador). É determinístico: a mesma semente produz exatamente os mesmos números, então
rodar de novo não faz o portal mudar sozinho. Use `-Seed 12345` para uma operação
diferente.

No fim ele reconfere sozinho o que a página confere, e imprime os números do período — se
o gerador e a tela discordarem, dá para ver na hora.

> O arquivo precisa continuar salvo em **UTF-8 com BOM**. O Windows PowerShell 5.1 lê
> script UTF-8 sem BOM como ANSI e embaralha todos os acentos.

---

## Fase 2: dado real

A aposta de arquitetura deste repositório é que **trocar dado falso por dado real não
encosta na interface.**

`assets/data.js` é o único módulo que busca alguma coisa. Todos os outros — `metrics.js`,
`charts.js`, as cinco telas, `app.js` — recebem o objeto que `loadData()` devolve e nunca
alcançam nada além dele. A tela está acoplada a um *formato*, não a uma fonte.

Então a Fase 2 tem duas formas possíveis, e as duas param naquele arquivo:

- **Um job agendado escreve o JSON.** Uma rotina chama a API do Commslayer e a da Shopify,
  calcula as mesmas contagens cruas e os mesmos arrays por ticket que o contrato define,
  escreve `data/*.json` e comita. **Nada neste repositório muda — nem o `data.js`.** O
  portal mostra número real porque os arquivos embaixo dele mudaram. É o caminho pretendido.
- **Um endpoint ao vivo.** Só a tabela `SOURCES` no topo do `data.js` muda: caminho vira
  URL. O `normalize()` continua devolvendo o formato idêntico.

**Token de API nunca pode chegar ao navegador.** Este é um site estático: tudo que a
página consegue ler, qualquer visitante consegue. Isso descarta chamar a API do helpdesk a
partir do código do cliente.

Antes de escrever a rotina de ingestão, uma pergunta decide se o resto é viável:
**o payload de mensagem do Commslayer distingue resposta de bot de resposta de gente?**
Primeira resposta está definida como tempo até a primeira resposta *humana*. Se resposta
automática for indistinguível de resposta de atendente, a métrica desaba para perto de
zero e para de significar qualquer coisa.

---

## Publicar no GitHub Pages

Empurre para `main` e o workflow em `.github/workflows/pages.yml` publica a raiz do
repositório. Não há etapa de build — o `upload-pages-artifact` sobe os arquivos como estão.

Habilite o Pages uma vez, nas configurações do repositório:

1. **Settings → Pages**
2. Em **Build and deployment**, ponha **Source** em **GitHub Actions**
   (não em "Deploy from a branch" — esse caminho ignora o workflow).
3. Empurre para `main`, ou rode o workflow à mão em **Actions → Deploy to GitHub Pages →
   Run workflow**.
4. A URL aparece no resumo da execução e de volta em Settings → Pages. Vai ser
   `https://<usuário>.github.io/<repo>/`.

Dois detalhes que importam para funcionar num subcaminho:

- **`.nojekyll`** na raiz impede o GitHub de passar os arquivos pelo Jekyll. Sem ele,
  qualquer coisa começando com underscore seria descartada.
- **Todo caminho neste repositório é relativo.** Nenhuma barra inicial em folha de estilo,
  script ou URL de fetch, e o `data.js` resolve os caminhos dos JSON contra
  `import.meta.url` em vez da raiz do documento. É isso que faz o site funcionar igual em
  `alineakiyama.github.io/quasi-dashboard/` e na raiz de um servidor.

---

## Estrutura

```
index.html               casca: barra lateral, topo, filtros, cinco contêineres de tela
serve.ps1                servidor local de desenvolvimento (não faz parte do site)
.nojekyll                desliga o Jekyll no Pages
assets/
  styles.css             todo o CSS; tokens de design como custom properties
  app.js                 partida: carrega os dados, liga a navegação e os filtros
  data.js                A CAMADA DE DADOS — o único arquivo que busca alguma coisa
  metrics.js             funções puras: toda a matemática, sem DOM
  charts.js              gráficos em SVG inline, tooltip compartilhado, formatadores
  views/overview.js      visão da semana, para o cliente
  views/operation.js     operação diária, para o time
  views/chargebacks.js   taxa, resultado das disputas e casos em aberto
  views/plans.js         planos de ação
  views/sources.js       fontes e definições
data/
  meta.json              limites do período, geração, fuso, metas
  reasons.json           registro dos motivos de contato: id, rótulo, cor
  tickets-daily.json     por motivo por dia: contagens e arrays de duração por ticket
  queue.json             retrato: fila, idade, mais antiga, fila crítica, atendentes
  refunds.json           uma linha por reembolso
  replacements.json      uma linha por reposição
  revenue.json           receita e pedidos por dia — denominador das taxas
  chargebacks.json       uma linha por disputa, com situação, taxa e resultado
  action-plans.json      uma linha por plano (escrito à mão, não sai do gerador)
tools/
  generate-data.ps1      o gerador dos dados fictícios
docs/
  DATA-CONTRACT.md       os esquemas JSON, campo a campo, com unidades e casos de borda
```

### Três convenções que vale saber antes de mexer no código

**Mediana nunca é guardada.** `tickets-daily.json` carrega um valor de duração por ticket,
não uma mediana pronta, porque mediana de medianas não é mediana — não haveria jeito
correto de produzir a mediana da semana, nem a mediana entre motivos. Toda mediana da
página é calculada sobre o conjunto real de tickets em escopo.

**Contagem e dinheiro somam; mediana e porcentagem não.** Elas são recalculadas sobre o
conjunto reunido, o que as pondera por volume. É por isso que a linha de total é rotulada
*Total / ponderado* e quase nunca é a média das células acima. Concretamente: a média
simples das dez medianas de primeira resposta por motivo, na última semana, dá 3,94 h — o
portal reporta **3,7 h**, que é a mediana das 1.011 conversas efetivamente respondidas.

**A ordem das cores das séries não é decoração.** Rosa, âmbar e azul passaram no teste de
separação sob daltonismo (ΔE 12,6 em OKLab, piso 8) e de contraste contra o branco. Trocar
um desses hex sem rodar o teste de novo pode deixar duas séries indistinguíveis para parte
dos leitores. Os valores estão no topo do `assets/styles.css`, com o resultado anotado.
