/* De onde vêm os números — a tela que responde "isso aí é medido como?" */

import { fmtStamp, fmtDay, fmtInt, esc } from '../charts.js';

export function renderSources(data) {
  const { meta, rows, refunds, replacements, chargebacks, queue, reasons } = data;

  const contagem = [
    ['meta.json', 'Period bounds and the targets', '1 object'],
    ['reasons.json', 'Registry of contact reasons', `${reasons.length} reasons`],
    ['tickets-daily.json', 'One row per reason per day', `${fmtInt(rows.length)} rows`],
    ['queue.json', 'A picture of the queue at one instant', `${fmtInt(queue.critical?.length ?? 0)} critical · ${fmtInt(queue.agents?.length ?? 0)} agents`],
    ['refunds.json', 'One row per refund', `${fmtInt(refunds.length)} refunds`],
    ['replacements.json', 'One row per replacement shipped', `${fmtInt(replacements.length)} replacements`],
    ['revenue.json', 'Revenue and orders per day, from Shopify', `${fmtInt(data.revenue.length)} days`],
    ['chargebacks.json', 'One row per dispute', `${fmtInt(chargebacks.length)} disputes`],
    ['action-plans.json', 'Hand-written, outside the generator', `${fmtInt(data.plans.length)} plans`],
  ];

  const definicoes = [
    ['First response',
     'Hours between a conversation being created and the first <b>human</b> reply. Auto-responses, macros fired by automation and bot messages do not count. It is the definition that depends most on the API: if Commslayer does not distinguish a bot from a person in the message payload, this metric collapses toward zero and stops meaning anything.'],
    ['Answered',
     'Conversations that received at least one human reply <b>that day</b> — counted by the reply, not by creation. A conversation born on Sunday and answered on Monday counts on Monday, and its value exceeds 24h.'],
    ['Resolution',
     'Hours between creation and the final close. If it was reopened and closed again, the <b>last</b> close is the one measured.'],
    ['Reopen rate',
     'Reopened ÷ closed in the same window.'],
    ['Queue',
     'Conversations open or pending at the instant of the snapshot. It is a count of what exists, not a total of what happened — which is why it cannot be added across periods.'],
    ['No reply for 24h+',
     'Open for more than 24 hours and still without any human reply. Different from the age bands: a conversation can be 30 hours old and already answered.'],
    ['Refund rate',
     '<b>Money over money</b>: amount refunded ÷ revenue for the same window. Never refunds ÷ conversations. That is what <code>revenue.json</code> exists for.'],
    ['Chargeback rate',
     '<b>Count ÷ orders</b>, not value ÷ revenue. It is the ratio card networks monitor and set thresholds on. The money ratio is reported alongside because it is what the problem costs, but it is not the number that triggers anything.'],
    ['Dispute win rate',
     'Won ÷ decided, where decided = won + lost + accepted. Pending cases are left out.'],
  ];

  const convencoes = [
    ['A median is never stored',
     '<code>tickets-daily.json</code> carries one value per ticket, not a pre-computed median, because a median of medians is not a median. If the file stored <code>frt_median</code> per reason per day, there would be no correct way to produce the week\'s median, or the median across reasons. Because the raw values are there, every median on the page — for a day, a reason, the week, any slice of the filter — is computed from the actual pool of conversations.'],
    ['Counts and money add up; medians and percentages do not',
     'The total row in each table is recomputed over the pooled set, which weights it by volume. That is why it is labelled <i>Total / weighted</i> and is almost never the average of the cells above it.'],
    ['Percentages are not stored',
     'Where both raw numbers exist, the JSON carries both and the division happens in <code>metrics.js</code>. The only percentage-shaped values in the data are <b>targets</b> in <code>meta.json</code>, which are thresholds, not measurements.'],
    ['Absent is <code>null</code>',
     'Never <code>""</code>, never <code>0</code>, never <code>"N/A"</code>. <code>0</code> means a measured zero.'],
    ['Duration is always hours, as a number',
     '<code>3.75</code> means 3h45. Never seconds, never minutes, never <code>"3h45m"</code>. Formatting is the interface\'s job.'],
  ];

  const fase2 = [
    ['A scheduled job writes the JSON',
     'A routine calls the Commslayer API and the Shopify API, computes the same raw counts and the same per-ticket arrays the contract defines, writes <code>data/*.json</code> and commits. <b>Nothing in this repository changes — not even <code>data.js</code>.</b> The page shows real numbers because the files underneath it changed. This is the intended route.'],
    ['A live endpoint',
     'Only the <code>SOURCES</code> table at the top of <code>data.js</code> changes: paths become URLs. The shape it returns stays identical.'],
    ['Still files, filled in by hand',
     'It works and it is honest while the volume is small. It stops working the day someone forgets to update it — and the <code>generated_at</code> in the sidebar is exactly what makes that visible.'],
  ];

  const li = (pairs) => pairs.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

  return `
    <section class="card">
      <div class="card__head"><div>
        <h2 class="card__title">How this portal is fed today</h2>
        <p class="card__note">Nine JSON files in <code>data/</code>. The interface computes nothing
        from anywhere else, and no module other than <code>assets/data.js</code> reads those files.</p>
      </div></div>
      <div class="card__body">
        <div class="tablewrap"><table>
          <thead><tr><th>File</th><th>What it is</th><th>Size today</th></tr></thead>
          <tbody>${contagem.map(([f, d, n]) => `
            <tr><td><code>${esc(f)}</code></td><td style="text-align:left">${esc(d)}</td><td style="text-align:left">${esc(n)}</td></tr>`).join('')}
          </tbody>
        </table></div>
        <dl class="stat-inline" style="margin-top:24px">
          <div><dt>Store</dt><dd style="font-size:17px">${esc(meta.brand.name)}<span class="sub">${esc(meta.brand.site)}</span></dd></div>
          <div><dt>Helpdesk</dt><dd style="font-size:17px">Commslayer<span class="sub">source of everything conversational</span></dd></div>
          <div><dt>Storefront</dt><dd style="font-size:17px">Shopify<span class="sub">revenue, orders and refunds</span></dd></div>
          <div><dt>Reporting timezone</dt><dd style="font-size:17px">${esc(meta.reporting_timezone)}<span class="sub">the zone days are closed in</span></dd></div>
          <div><dt>Generated</dt><dd style="font-size:17px">${esc(fmtStamp(meta.generated_at))}<span class="sub">a stale portal shows up as stale</span></dd></div>
        </dl>
      </div>
    </section>

    <section class="card">
      <div class="card__head"><div>
        <h2 class="card__title">What each number means</h2>
        <p class="card__note">Worth reading before arguing about whether a number is good or bad.</p>
      </div></div>
      <div class="card__body"><dl class="deflist">${li(definicoes)}</dl></div>
    </section>

    <section class="card">
      <div class="card__head"><div>
        <h2 class="card__title">Conventions that hold everywhere</h2>
      </div></div>
      <div class="card__body"><dl class="deflist">${li(convencoes)}</dl></div>
    </section>

    <section class="card">
      <div class="card__head"><div>
        <h2 class="card__title">Phase 2: swapping made-up numbers for real ones</h2>
        <p class="card__note">The architectural bet of this project is that swapping fake data for
        real data <b>does not touch the interface</b>. Only <code>assets/data.js</code> fetches
        anything; everything else receives the object it returns. The screen is coupled to a shape,
        not to a source.</p>
      </div></div>
      <div class="card__body">
        <dl class="deflist">${li(fase2)}</dl>
        <p class="note note--scoped" style="margin-top:20px">
          <b>An API token must never reach the browser.</b> If this portal is published as a static
          site, anything the page can read, any visitor can read. That rules out calling the
          Commslayer API from client-side code — the fetching has to happen in a job, outside.
        </p>
        <p class="note">
          Before writing the ingestion routine, one question decides whether the rest is viable:
          <b>does the Commslayer message payload distinguish a bot reply from a human one?</b>
          First response is defined as time to the first <i>human</i> reply. If auto-responses are
          indistinguishable from agent replies, the metric collapses toward zero and stops meaning
          anything.
        </p>
      </div>
    </section>

    <section class="card">
      <div class="card__head"><div>
        <h2 class="card__title">About the numbers on this page</h2>
      </div></div>
      <div class="card__body">
        <p style="font-size:13.5px;color:var(--ink-2);max-width:80ch">
          Every one of them is <b>made up</b>. They were produced by <code>tools/generate-data.ps1</code>
          with a fixed seed, so running it again produces exactly the same numbers and the portal never
          shifts on its own. They are plausible and internally consistent — the medians match the arrays,
          the age bands add up to the queue, the agents add up to the day — but they were
          <b>generated, not measured</b>. What is real here is the shape, the definitions and the maths.
        </p>
        <p class="note">The files cover ${esc(fmtDay(meta.data_start))} to ${esc(fmtDay(meta.data_end))}
        — ${fmtInt(data.revenue.length)} days. Every period in the selector is cut from that range, and the
        quick ranges count back from the last day of data, not from today.</p>
      </div>
    </section>
  `;
}
