/**
 * client.js — DSH Client 半（Web 面板）。
 *
 * 形态完全遵循官方模板与本机已验证的 @local/genshin-analyzer/client.js：
 *   window.__ModuleLoader__.load({ id: '<包名>', factory(require) {...} })
 *  - factory 必须无副作用；React 由浏览器模块表提供，只能 require('react')。
 *  - 不 require 任何 @deepseek-ai/dsh-client-* 包（它们随时会变，且抛错会整块 blank 掉槽位）。
 *  - 样式只用 --dsw-alias-* / --dsw-specific-* 主题变量，容器继承宿主主题。
 *  - 槽位: conversation.composer.dock（官方文档点名的、已分配空间的 composer 下方插槽）。
 *
 * ⚠️ 这一版面板**不自己调 Host**（client→host 的 RPC 需要额外的 gateway 通道，未在本机验证）。
 *    它只做「控制面」：把烧钱指令复制到剪贴板，由你粘贴发送，Agent 再调用 burn_tokens 工具。
 *    「开始烧」按钮额外要求勾选风险确认，避免误触真实扣费。
 */
window.__ModuleLoader__.load({
  id: '@local/token-burner',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const TOOL_NAME = 'burn_tokens';
    const DEFAULT_AMOUNT = '0.1';

    function promptPlan(amount) {
      return '用 ' + TOOL_NAME + ' 出一份烧钱计划：action="plan"，amountCny=' + amount
        + '。只出计划，不要执行、不要扣费。';
    }
    function promptStart(amount) {
      return '用 ' + TOOL_NAME + ' 开始烧钱：action="start"，amountCny=' + amount
        + '，confirm=true。这是用户明确要求的真实扣费操作。';
    }
    function promptStatus() {
      return '用 ' + TOOL_NAME + ' 查一下当前烧钱进度：action="status"。';
    }
    function promptStop() {
      return '用 ' + TOOL_NAME + ' 停机：action="stop"。';
    }
    function promptReconcile() {
      return '用 ' + TOOL_NAME + ' 对账：action="reconcile"。注意余额接口有结算延迟，'
        + '如果差额明显小于账本，说明还没结算完，过几分钟再查一次；不要把差额当成准确花费。';
    }

    const S = {
      root: { display: 'flex', flexDirection: 'column', gap: '8px', margin: '0 auto', maxWidth: '100%', boxSizing: 'border-box' },
      pill: {
        alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: '6px',
        padding: '4px 10px', borderRadius: 'var(--dsw-radius-lg, 8px)', cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25))',
        background: 'var(--dsw-alias-bg-base, transparent)',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        font: 'inherit', fontSize: 'var(--dsw-font-xs-13, 13px)', lineHeight: '20px',
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25))',
        borderRadius: 'var(--dsw-radius-lg, 10px)',
        background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-base, transparent))',
        boxShadow: 'var(--dsw-elevation-panel, none)',
        padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px',
      },
      head: { display: 'flex', alignItems: 'center', gap: '8px' },
      title: { color: 'var(--dsw-alias-label-primary, inherit)', fontSize: 'var(--dsw-font-xs-13, 13px)', fontWeight: 500, flex: '1 1 auto' },
      close: {
        border: 'none', background: 'transparent', cursor: 'pointer', padding: '0 2px',
        color: 'var(--dsw-alias-label-tertiary, inherit)', font: 'inherit', fontSize: '14px', lineHeight: '20px',
      },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      input: {
        flex: '1 1 130px', minWidth: '110px', boxSizing: 'border-box',
        padding: '5px 8px', borderRadius: 'var(--dsw-radius-md, 8px)',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))',
        background: 'var(--dsw-specific-input-major, var(--dsw-alias-bg-base, transparent))',
        color: 'var(--dsw-alias-label-primary, inherit)', font: 'inherit', fontSize: '13px', lineHeight: '20px',
      },
      button: {
        padding: '5px 12px', cursor: 'pointer', borderRadius: 'var(--dsw-radius-md, 8px)',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))',
        background: 'var(--dsw-alias-bg-base, transparent)',
        color: 'var(--dsw-alias-label-primary, inherit)', font: 'inherit', fontSize: '13px', lineHeight: '20px',
      },
      buttonPrimary: {
        padding: '5px 12px', cursor: 'pointer', borderRadius: 'var(--dsw-radius-md, 8px)',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))',
        background: 'var(--dsw-alias-bg-base, transparent)',
        color: 'var(--dsw-alias-label-primary, inherit)', font: 'inherit', fontSize: '13px', lineHeight: '20px', fontWeight: 500,
      },
      buttonDanger: {
        padding: '5px 12px', cursor: 'pointer', borderRadius: 'var(--dsw-radius-md, 8px)',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))',
        background: 'var(--dsw-specific-menu, transparent)',
        color: 'inherit', font: 'inherit', fontSize: '13px', lineHeight: '20px', fontWeight: 600,
      },
      warn: {
        color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: 'var(--dsw-font-xs-13, 12px)',
        lineHeight: '18px', padding: '6px 8px', borderRadius: 'var(--dsw-radius-md, 8px)',
        border: '1px dashed var(--dsw-alias-border-l2, rgba(200,80,80,.45))',
      },
      hint: { color: 'var(--dsw-alias-label-tertiary, inherit)', fontSize: 'var(--dsw-font-xs-13, 12px)', lineHeight: '18px' },
      note: { color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: '12px', lineHeight: '18px' },
      err: { color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: '12px', lineHeight: '18px' },
      mono: { fontFamily: 'var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace)' },
      checkRow: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', lineHeight: '18px' },
    };

    function TokenBurnerDock() {
      const [open, setOpen] = React.useState(false);
      const [amount, setAmount] = React.useState(DEFAULT_AMOUNT);
      const [armed, setArmed] = React.useState(false);
      const [note, setNote] = React.useState('');
      const [failed, setFailed] = React.useState(false);

      const n = Number(String(amount).trim());
      const valid = Number.isFinite(n) && n > 0;

      const copy = (text) => {
        setFailed(false);
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(text).then(
              () => { setFailed(false); setNote('已复制，粘贴到输入框发送即可。'); },
              () => { setFailed(true); setNote('自动复制被浏览器拒绝，请手动复制下面的文本。'); },
            );
          } else {
            setFailed(true);
            setNote('当前环境不支持自动复制，请手动复制下面的文本。');
          }
        } catch (error) {
          setFailed(true);
          setNote('自动复制失败，请手动复制下面的文本。');
        }
      };

      if (!open) {
        return h('div', { style: S.root },
          h('button', {
            type: 'button', style: S.pill, title: '按指定金额快速消耗 token（会真实扣费）',
            onClick: () => setOpen(true),
          },
            h('span', { 'aria-hidden': true }, '🔥'),
            h('span', null, '烧 token'),
          ),
        );
      }

      const planText = valid ? promptPlan(n) : '';
      const startText = valid ? promptStart(n) : '';

      return h('div', { style: S.root },
        h('div', { style: S.card },
          h('div', { style: S.head },
            h('span', { style: S.title }, '按金额烧 token · 真实扣费压测'),
            h('button', { type: 'button', style: S.close, title: '收起', onClick: () => setOpen(false) }, '×'),
          ),
          h('div', { style: S.warn },
            '⚠️ 风险提示：本功能会真实调用 DeepSeek 模型并真实扣费，费用不可撤销、不可退款。'
            + '本次生效的硬上限以 `doctor` 第 5 节显示的为准（出厂默认 1 元，可配置调高）；'
            + '余额差只能当上界，唯一权威的对账方式是官方账单。请先用极小金额验证。',
          ),
          h('div', { style: S.row },
            h('input', {
              style: S.input, value: amount, inputMode: 'decimal', placeholder: '目标金额（元）',
              'aria-label': '目标金额（元）',
              onChange: (e) => { setAmount(e.target.value.replace(/[^\d.]/g, '').slice(0, 12)); setNote(''); },
            }),
            h('button', {
              type: 'button', style: valid ? S.buttonPrimary : S.button,
              onClick: () => copy(planText),
            }, '复制「出计划」'),
          ),
          h('div', { style: S.hint },
            '「出计划」永远不花钱：它会算出当前单价档位（高峰 2× / 空闲减半）、需要多少 token、多少次请求、预计耗时，',
            '以及输入通道与输出通道的速度对照。建议每次烧钱前先看计划。',
          ),
          h('div', { style: S.checkRow },
            h('input', {
              type: 'checkbox', checked: armed, 'aria-label': '确认风险',
              onChange: (e) => setArmed(e.target.checked),
            }),
            h('span', null, '我已了解这会真实扣费，且金额不可撤销'),
          ),
          h('div', { style: S.row },
            h('button', {
              type: 'button',
              style: armed && valid ? S.buttonDanger : S.button,
              disabled: !armed || !valid,
              title: armed ? '' : '请先勾选风险确认',
              onClick: () => copy(startText),
            }, '复制「开始烧」'),
            h('button', { type: 'button', style: S.button, onClick: () => copy(promptStatus()) }, '复制「查进度」'),
            h('button', { type: 'button', style: S.button, onClick: () => copy(promptStop()) }, '复制「停机」'),
            h('button', { type: 'button', style: S.button, onClick: () => copy(promptReconcile()) }, '复制「对账」'),
          ),
          note ? h('div', { style: failed ? S.err : S.note }, note) : null,
          h('div', { style: S.hint },
            'Agent 会调用 ', h('code', { style: S.mono }, TOOL_NAME),
            ' 工具执行。烧钱请求直连模型、不写会话记录，所以这笔消费不会出现在 DSH 自己的 token 计量里；',
            '插件会在开始与结束时各查一次账户余额做对账，并把每次请求写进 ',
            h('code', { style: S.mono }, '~/.dsh/token-burner/runs/*.jsonl'), '。',
            '⚠️ 但余额接口有结算延迟，且同一账户上其他用量（包括跑这个插件的 agent 会话自己）都会混进差额 —— ',
            '所以余额差只能当上界，真正准确的是账本。',
          ),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'token-burner.dock',
          order: 7,
        }, TokenBurnerDock));
      },
    };
  },
});
