/* The printing app's window. Plain script: no framework, no remote content. */
const root = document.getElementById('app');
let state = null;
let pairing = { busy: false, error: '' };

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== false && value != null) node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function renderUnpaired() {
  const input = el('input', {
    inputmode: 'numeric',
    maxlength: '6',
    autocomplete: 'off',
    'aria-label': 'Six-digit code',
    placeholder: '000000',
    autofocus: true,
  });
  const button = el(
    'button',
    { type: 'submit', disabled: pairing.busy },
    pairing.busy ? 'Linking…' : 'Link this PC',
  );
  const form = el(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        pairing = { busy: true, error: '' };
        render();
        const result = await window.printAgent.pair(input.value);
        pairing = {
          busy: false,
          error: result.ok ? '' : result.error || 'Could not link this PC.',
        };
        render();
      },
    },
    input,
    button,
    pairing.error && el('p', { class: 'error', role: 'alert' }, pairing.error),
  );
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 6);
  });
  return [
    el('h1', {}, 'Link this PC to your shop'),
    el(
      'p',
      { class: 'muted' },
      'This app prints your customers’ orders for you, so you only press Print.',
    ),
    state.notice && el('p', { class: 'notice' }, state.notice),
    el(
      'div',
      { class: 'card' },
      el(
        'ol',
        {},
        el('li', {}, 'Open your shop dashboard and go to Printing.'),
        el('li', {}, 'Press “Set up printing” to get a six-digit code.'),
        el('li', {}, 'Type the code here.'),
      ),
      form,
    ),
  ];
}

function printerTags(printer) {
  return [
    printer.isColor === true && el('span', { class: 'tag' }, 'Colour'),
    printer.isColor === false && el('span', { class: 'tag' }, 'Black & white'),
    printer.supportsDuplex === true && el('span', { class: 'tag' }, '2-sided'),
    printer.offline && el('span', { class: 'tag bad' }, 'Offline'),
  ];
}

function renderLinked() {
  const online = state.phase === 'online';
  const headline = online
    ? 'Printing is connected'
    : state.phase === 'connecting'
      ? 'Connecting…'
      : 'Reconnecting…';
  return [
    el(
      'div',
      { class: 'card status' },
      el('span', { class: `dot ${online ? 'ok' : ''}`, 'aria-hidden': 'true' }),
      el(
        'div',
        {},
        el('h1', {}, online ? `✓ ${headline}` : headline),
        el('p', { class: 'muted' }, `Shop: ${state.shopName || '—'}`),
      ),
    ),
    !online &&
      el(
        'p',
        { class: 'notice' },
        'The app keeps trying. Orders you send to print will wait and print as soon as it is back.',
      ),
    state.notice && el('p', { class: 'notice' }, state.notice),
    el('h2', {}, 'Printers on this PC'),
    el(
      'div',
      { class: 'card' },
      state.printers.length === 0
        ? el('p', { class: 'muted' }, 'No printers found yet.')
        : el(
            'ul',
            { class: 'list' },
            state.printers.map((p) =>
              el('li', {}, el('span', {}, p.name), el('span', {}, printerTags(p))),
            ),
          ),
    ),
    el('h2', {}, 'Recent prints'),
    el(
      'div',
      { class: 'card' },
      state.jobs.length === 0
        ? el('p', { class: 'muted' }, 'Nothing printed yet.')
        : el(
            'ul',
            { class: 'list' },
            state.jobs.map((job) =>
              el(
                'li',
                {},
                el('span', {}, job.label, job.error && el('div', { class: 'muted' }, job.error)),
                el(
                  'span',
                  {
                    class:
                      job.status === 'failed'
                        ? 'job-bad'
                        : job.status === 'done'
                          ? 'job-ok'
                          : 'muted',
                  },
                  job.status === 'done'
                    ? 'Printed'
                    : job.status === 'failed'
                      ? 'Failed'
                      : 'Printing…',
                ),
              ),
            ),
          ),
    ),
    el(
      'footer',
      {},
      el('span', {}, `Version ${state.version}`),
      el(
        'button',
        {
          class: 'link',
          type: 'button',
          onclick: () => {
            if (confirm('Unlink this PC from the shop? Orders will no longer print here.')) {
              void window.printAgent.unpair();
            }
          },
        },
        'Unlink this PC',
      ),
    ),
  ];
}

function render() {
  if (!state) return;
  root.replaceChildren(
    ...(state.phase === 'unpaired' ? renderUnpaired() : renderLinked()).filter(Boolean),
  );
}

window.printAgent.onState((next) => {
  state = next;
  render();
});
void window.printAgent.getState().then((initial) => {
  state = initial;
  render();
});
