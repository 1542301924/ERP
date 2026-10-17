/**
 * 小程序运行配置。
 *
 * ⚠️ 这是全项目**唯一**需要填 AppID / 云环境 ID 的地方：
 *   1. `ENV.envId`：微信开发者工具 →「云开发」控制台 → 环境 ID（形如 qingsong-inventory-1a2b3c）。
 *      留空则使用云开发默认环境。
 *   2. `project.config.json` 的 `appid`：替换 `touristappid` 为你的小程序 AppID。
 */
module.exports = {
  ENV: {
    /** 云环境 ID；留空 = 默认环境。 */
    envId: '',
  },

  /** 云函数名：所有能力收敛在单个入口函数 `mp`，按 `action` 分发（见 cloudfunctions/mp/handler.js）。 */
  FN: {
    MP: 'mp',
  },

  /** 云函数调用超时 / 重试。 */
  CALL: {
    timeoutMs: 10000,
    /** 网络类错误的重试次数（幂等查询才重试，提交类由离线队列负责）。 */
    retry: 2,
    retryDelayMs: 800,
  },

  /** 离线队列。 */
  QUEUE: {
    /** 本地最多保留的待同步操作数。 */
    max: 200,
    /** 单次提交批量。 */
    batch: 20,
    /** 第 n 次重试的退避基数（线性退避）。 */
    retryDelayMs: 3000,
    /** 超过该次数后标记为失败并需人工处理。 */
    maxRetry: 5,
  },

  /** 商品/库存等只读缓存的本地有效期。 */
  CACHE_TTL_MS: 5 * 60 * 1000,
};
