import { describe, expect, it } from 'vitest';

import type { CandidateDecision } from '../src/core/candidate-verification';
import {
  applyXianyuCandidateDecisions,
  planXianyuCandidateAdjudication,
} from '../src/adapters/recognition/xianyu-candidate-adjudication';
import type {
  LocatedOcrWord,
  XianyuSemanticRegionId,
  XianyuSemanticRegionLayout,
} from '../src/adapters/recognition/xianyu-semantic-regions';

function word(
  text: string,
  left: number,
  top: number,
  right: number,
  bottom: number,
): LocatedOcrWord {
  return { text, left, top, right, bottom };
}

function layout(
  regions: Partial<Record<XianyuSemanticRegionId, LocatedOcrWord[]>>,
  promotionWords: LocatedOcrWord[] = [],
): XianyuSemanticRegionLayout {
  const empty = () => ({ startY: 0, endY: 0, words: [] });
  return {
    regions: {
      platform_status: empty(),
      shipping_information: empty(),
      purchased_items: empty(),
      amount_summary: empty(),
      order_details: empty(),
      fulfillment_signals: empty(),
      ...Object.fromEntries(Object.entries(regions).map(([region, words]) => [
        region,
        {
          startY: Math.min(...words.map((entry) => entry.top)),
          endY: Math.max(...words.map((entry) => entry.bottom)),
          words,
        },
      ])),
    },
    excludedPromotion: {
      startY: promotionWords[0]?.top ?? 0,
      endY: promotionWords.at(-1)?.bottom ?? 0,
      words: promotionWords,
    },
  };
}

describe('闲鱼有限候选规划与本地补丁', () => {
  it('多个收货手机号形成原子联系人候选，选择后只回填本机预绑定值', () => {
    const extracted = {
      shipping_information: {
        recipient: null,
        recipient_phone_line_text: null,
        phone: null,
        address: '广东省惠州市惠城区安全路1号',
      },
    };
    const regionLayout = layout({
      shipping_information: [
        word('彭 13881173018 复制', 50, 320, 470, 355),
        word('刘环湘 13352789806 去发货', 50, 370, 570, 405),
        word('广东省惠州市惠城区安全路1号', 50, 420, 720, 455),
      ],
    }, [word('推广联系人 13600000000', 50, 900, 600, 940)]);

    const plan = planXianyuCandidateAdjudication({
      extracted,
      layout: regionLayout,
    });

    expect(plan.candidateSets).toHaveLength(1);
    expect(plan.candidateSets[0]).toMatchObject({
      ambiguityId: 'xianyu:shipping_information:contact',
      region: 'shipping_information',
      field: 'shipping_contact',
      candidates: [
        { displayText: '彭 13881173018' },
        { displayText: '刘环湘 13352789806' },
      ],
    });
    expect(plan.candidateSets[0]?.contextLines).toEqual([
      {
        lineId: 'shipping_information:line:1',
        text: '彭 13881173018 复制',
        left: 50,
        top: 320,
        right: 470,
        bottom: 355,
      },
      {
        lineId: 'shipping_information:line:2',
        text: '刘环湘 13352789806 去发货',
        left: 50,
        top: 370,
        right: 570,
        bottom: 405,
      },
      {
        lineId: 'shipping_information:line:3',
        text: '广东省惠州市惠城区安全路1号',
        left: 50,
        top: 420,
        right: 720,
        bottom: 455,
      },
    ]);
    expect(JSON.stringify(plan.candidateSets)).not.toContain('推广联系人');

    const selected = plan.candidateSets[0]?.candidates[1];
    const decisions: CandidateDecision[] = [{
      ambiguityId: 'xianyu:shipping_information:contact',
      resolution: 'selected',
      candidateId: selected?.candidateId ?? '',
    }];
    const applied = applyXianyuCandidateDecisions(extracted, plan, decisions);

    expect(applied).toEqual({
      shipping_information: {
        recipient: '刘环湘',
        recipient_phone_line_text: '刘环湘 13352789806',
        phone: '13352789806',
        address: '广东省惠州市惠城区安全路1号',
      },
    });
    expect(extracted.shipping_information.recipient).toBeNull();
  });

  it('顶部状态区只把互相冲突的程序已知状态列为候选', () => {
    const extracted = {
      platform_status: { top_status_text: null },
    };
    const regionLayout = layout({
      platform_status: [
        word('买家已付款，请尽快发货', 40, 180, 720, 235),
        word('交易已取消', 40, 245, 300, 280),
      ],
    }, [word('推广卡片：退款成功', 50, 900, 600, 940)]);

    const plan = planXianyuCandidateAdjudication({
      extracted,
      layout: regionLayout,
    });

    expect(plan.candidateSets).toHaveLength(1);
    expect(plan.candidateSets[0]).toMatchObject({
      ambiguityId: 'xianyu:platform_status:transaction_status',
      region: 'platform_status',
      field: 'platform_status',
      candidates: [
        { displayText: '已付款' },
        { displayText: '已取消' },
      ],
    });
    expect(plan.candidateSets[0]?.contextLines.map((line) => line.text)).toEqual([
      '买家已付款，请尽快发货',
      '交易已取消',
    ]);
    expect(JSON.stringify(plan.candidateSets)).not.toContain('推广卡片');

    const cancelled = plan.candidateSets[0]?.candidates.find(
      (candidate) => candidate.displayText === '已取消',
    );
    const applied = applyXianyuCandidateDecisions(extracted, plan, [{
      ambiguityId: 'xianyu:platform_status:transaction_status',
      resolution: 'selected',
      candidateId: cancelled?.candidateId ?? '',
    }]);

    expect(applied).toEqual({
      platform_status: { top_status_text: '交易已取消' },
    });
    expect(extracted.platform_status.top_status_text).toBeNull();
  });

  it('六区模块已恢复后把状态决定写回页面状态字段而不创建旧模块', () => {
    const extracted = {
      page_header_status_text: null,
      page_context: { top_status_text: null, global_controls: ['去发货'] },
    };
    const plan = planXianyuCandidateAdjudication({
      extracted,
      layout: layout({
        platform_status: [
          word('买家已付款，请尽快发货', 40, 180, 720, 235),
          word('交易已取消', 40, 245, 300, 280),
        ],
      }),
    });
    const cancelled = plan.candidateSets[0]?.candidates.find(
      (candidate) => candidate.displayText === '已取消',
    );

    const applied = applyXianyuCandidateDecisions(extracted, plan, [{
      ambiguityId: plan.candidateSets[0]?.ambiguityId ?? '',
      resolution: 'selected',
      candidateId: cancelled?.candidateId ?? '',
    }]);

    expect(applied).toEqual({
      page_header_status_text: '交易已取消',
      page_context: {
        top_status_text: '交易已取消',
        global_controls: ['去发货'],
      },
    });
    expect(applied).not.toHaveProperty('platform_status');
  });

  it('未知标签行紧邻价格行时只枚举有限标题并回填对应商品', () => {
    const extracted = {
      purchased_items: {
        items: [
          { title: '商品甲', unit_price: '6.00' },
          { title: null, unit_price: '10.00', quantity: 2 },
        ],
      },
    };
    const regionLayout = layout({
      purchased_items: [
        word('商品甲 ¥6.00', 250, 520, 740, 560),
        word('苹果：iPhone 15', 250, 660, 650, 695),
        word('Pro ¥10.00', 250, 700, 740, 735),
        word('款式：白色 ×2', 250, 760, 650, 795),
      ],
    });

    const plan = planXianyuCandidateAdjudication({
      extracted,
      layout: regionLayout,
    });

    expect(plan.candidateSets).toHaveLength(1);
    expect(plan.candidateSets[0]).toMatchObject({
      ambiguityId: 'xianyu:purchased_items:item_title:1',
      region: 'purchased_items',
      field: 'item_title',
      itemIndex: 1,
      candidates: [
        { displayText: '苹果：iPhone 15Pro' },
        { displayText: 'Pro' },
      ],
    });
    expect(plan.candidateSets[0]?.contextLines).toEqual([
      {
        lineId: 'purchased_items:line:2',
        text: '苹果：iPhone 15',
        left: 250,
        top: 660,
        right: 650,
        bottom: 695,
      },
      {
        lineId: 'purchased_items:line:3',
        text: 'Pro ¥10.00',
        left: 250,
        top: 700,
        right: 740,
        bottom: 735,
      },
    ]);

    const fullTitle = plan.candidateSets[0]?.candidates[0];
    const applied = applyXianyuCandidateDecisions(extracted, plan, [{
      ambiguityId: 'xianyu:purchased_items:item_title:1',
      resolution: 'selected',
      candidateId: fullTitle?.candidateId ?? '',
    }]);

    expect(applied).toEqual({
      purchased_items: {
        items: [
          { title: '商品甲', unit_price: '6.00' },
          {
            title: '苹果：iPhone 15Pro',
            unit_price: '10.00',
            quantity: 2,
          },
        ],
      },
    });
    expect(extracted.purchased_items.items[1]?.title).toBeNull();
  });

  it('规划阶段排除超出安全上限的歧义但保留同图其他有界候选', () => {
    const oversizedLine = `未知标签：${'长'.repeat(2_001)}`;
    const plan = planXianyuCandidateAdjudication({
      extracted: {
        platform_status: { top_status_text: null },
        purchased_items: { items: [{ title: null, unit_price: '8.00' }] },
      },
      layout: layout({
        platform_status: [
          word('买家已付款，请尽快发货', 40, 180, 720, 235),
          word('交易已取消', 40, 245, 300, 280),
        ],
        purchased_items: [
          word(oversizedLine, 250, 520, 740, 560),
          word('尾部标题 ¥8.00', 250, 570, 740, 610),
        ],
      }),
    });

    expect(plan.candidateSets.map(({ ambiguityId }) => ambiguityId)).toEqual([
      'xianyu:platform_status:transaction_status',
    ]);
    expect([...plan.candidatePatches.keys()].every((candidateId) => (
      candidateId.startsWith('xianyu:platform_status:transaction_status:')
    ))).toBe(true);
    expect(plan.rejectedCandidateSets).toHaveLength(1);
    expect(plan.rejectedCandidateSets[0]).toMatchObject({
      ambiguityId: 'xianyu:purchased_items:item_title:0',
      region: 'purchased_items',
      field: 'item_title',
    });
    expect(plan.rejectedCandidateSets[0]?.contextLines.every(
      ({ text }) => text.length <= 2_000,
    )).toBe(true);
  });

  it('压缩超过 40 行的审计依据时为每个候选至少保留一条来源行', () => {
    const pendingLines = Array.from({ length: 41 }, (_, index) => (
      word(`未知${index + 1}：标题片段${index + 1}`, 250, 500 + index * 20, 700, 518 + index * 20)
    ));
    const priceLine = word('尾部标题 ¥8.00', 250, 1_340, 740, 1_360);

    const plan = planXianyuCandidateAdjudication({
      extracted: {},
      layout: layout({ purchased_items: [...pendingLines, priceLine] }),
    });

    expect(plan.candidateSets).toEqual([]);
    expect(plan.rejectedCandidateSets).toHaveLength(1);
    const rejected = plan.rejectedCandidateSets[0]!;
    expect(rejected.contextLines.length).toBeLessThanOrEqual(40);
    expect(rejected.candidates).toHaveLength(2);
    expect(rejected.candidates.every(({ evidenceRefs }) => evidenceRefs.length > 0)).toBe(true);
    expect(rejected.contextLines.map(({ text }) => text)).toContain('尾部标题 ¥8.00');
  });

  it('同一截图的候选裁决规划不超过单次歧义数上限', () => {
    const itemWords = Array.from({ length: 21 }, (_, index) => [
      word(`未知${index + 1}：商品${index + 1}`, 250, 500 + index * 80, 650, 530 + index * 80),
      word(`尾部${index + 1} ¥1.00`, 250, 535 + index * 80, 740, 565 + index * 80),
    ]).flat();

    const plan = planXianyuCandidateAdjudication({
      extracted: {},
      layout: layout({ purchased_items: itemWords }),
    });

    expect(plan.candidateSets).toHaveLength(20);
    expect(plan.candidatePatches.size).toBe(40);
    expect(plan.rejectedCandidateSets).toHaveLength(1);
    expect(plan.rejectedCandidateSets[0]?.ambiguityId).toBe(
      'xianyu:purchased_items:item_title:20',
    );
  });

  it('超过逐项审计上限时保留明确的溢出失败记录而不静默丢弃', () => {
    const itemWords = Array.from({ length: 101 }, (_, index) => [
      word(`未知${index + 1}：商品${index + 1}`, 250, 500 + index * 80, 650, 530 + index * 80),
      word(`尾部${index + 1} ¥1.00`, 250, 535 + index * 80, 740, 565 + index * 80),
    ]).flat();

    const plan = planXianyuCandidateAdjudication({
      extracted: {},
      layout: layout({ purchased_items: itemWords }),
    });

    expect(plan.candidateSets).toHaveLength(20);
    expect(plan.rejectedCandidateSets).toHaveLength(80);
    const overflow = plan.rejectedCandidateSets.at(-1)!;
    expect(overflow).toMatchObject({
      ambiguityId: 'xianyu:candidate_audit:overflow',
      field: 'candidate_overflow',
    });
    expect(overflow.contextLines[0]?.text).toContain('另有 2 项歧义');
    expect(overflow.candidates[1]?.displayText).toContain('2 项歧义需人工确认');
  });

  it('手机号同行只有功能按钮而没有姓名时不伪造联系人候选', () => {
    const regionLayout = layout({
      shipping_information: [
        word('去发货 13881173018', 50, 320, 470, 355),
        word('刘环湘 13352789806 复制', 50, 370, 570, 405),
      ],
    });

    const plan = planXianyuCandidateAdjudication({
      extracted: {},
      layout: regionLayout,
    });

    expect(plan.candidateSets).toEqual([]);
    expect(plan.candidatePatches.size).toBe(0);
  });

  it('未知、跨歧义或重复的决定都不能触发本地补丁', () => {
    const extracted = {
      platform_status: { top_status_text: null },
      shipping_information: {
        recipient: null,
        recipient_phone_line_text: null,
        phone: null,
      },
    };
    const plan = planXianyuCandidateAdjudication({
      extracted,
      layout: layout({
        platform_status: [
          word('买家已付款，请尽快发货', 40, 180, 720, 235),
          word('交易已取消', 40, 245, 300, 280),
        ],
        shipping_information: [
          word('彭 13881173018 复制', 50, 320, 470, 355),
          word('刘环湘 13352789806 去发货', 50, 370, 570, 405),
        ],
      }),
    });
    const statusSet = plan.candidateSets.find(
      (candidateSet) => candidateSet.region === 'platform_status',
    );
    const shippingSet = plan.candidateSets.find(
      (candidateSet) => candidateSet.region === 'shipping_information',
    );
    const cancelled = statusSet?.candidates.find(
      (candidate) => candidate.displayText === '已取消',
    );
    const firstContact = shippingSet?.candidates[0];
    const secondContact = shippingSet?.candidates[1];

    const duplicateSkipped = applyXianyuCandidateDecisions(extracted, plan, [
      {
        ambiguityId: statusSet?.ambiguityId ?? '',
        resolution: 'selected',
        candidateId: cancelled?.candidateId ?? '',
      },
      {
        ambiguityId: shippingSet?.ambiguityId ?? '',
        resolution: 'selected',
        candidateId: firstContact?.candidateId ?? '',
      },
      {
        ambiguityId: shippingSet?.ambiguityId ?? '',
        resolution: 'selected',
        candidateId: secondContact?.candidateId ?? '',
      },
    ]);
    expect(duplicateSkipped).toEqual({
      platform_status: { top_status_text: '交易已取消' },
      shipping_information: {
        recipient: null,
        recipient_phone_line_text: null,
        phone: null,
      },
    });

    const crossAmbiguitySkipped = applyXianyuCandidateDecisions(extracted, plan, [{
      ambiguityId: shippingSet?.ambiguityId ?? '',
      resolution: 'selected',
      candidateId: cancelled?.candidateId ?? '',
    }]);
    expect(crossAmbiguitySkipped).toEqual(extracted);

    const unknownSkipped = applyXianyuCandidateDecisions(extracted, plan, [{
      ambiguityId: 'xianyu:unknown:field',
      resolution: 'selected',
      candidateId: firstContact?.candidateId ?? '',
    }]);
    expect(unknownSkipped).toEqual(extracted);
  });

  it('识别原文可以由本机规则唯一确定时不产生候选', () => {
    const plan = planXianyuCandidateAdjudication({
      extracted: {},
      layout: layout({
        platform_status: [
          word('买家已付款，请尽快发货', 40, 180, 720, 235),
        ],
        shipping_information: [
          word('刘环湘 13352789806 复制', 50, 330, 620, 365),
          word('广东省惠州市惠城区安全路1号', 50, 380, 720, 425),
        ],
        purchased_items: [
          word('确定商品 ¥8.00', 250, 540, 740, 580),
          word('款式：白色', 250, 600, 650, 635),
        ],
      }),
    });

    expect(plan.candidateSets).toEqual([]);
    expect(plan.candidatePatches.size).toBe(0);
  });
});
