<script setup lang="ts">
/**
 * 登录页：用户名下拉选择（无需输入账号）+ 口令。
 *
 * 内置 admin 口令为空，直接点「登录」即可进入；其余用户若设置了口令则需输入。
 *
 * 版式：左侧品牌视觉面（真实仓储静物照 + 品牌与一句话说明），右侧登录表单，
 * 文案全部压在画面留白区，保证对比度与可读性。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api } from '../composables/useCrud';
import { useAuthStore } from '../stores/auth';
import type { LoginUser } from '../../../env';

const router = useRouter();
const auth = useAuthStore();

const users = ref<LoginUser[]>([]);
const userId = ref('');
const password = ref('');
const loading = ref(false);

const selected = computed(() => users.value.find((u) => u.id === userId.value) ?? null);
const placeholder = computed(() => `请选择登录账号（共 ${users.value.length} 个）`);

async function loadUsers(): Promise<void> {
  try {
    users.value = await api().auth.users();
    if (!userId.value && users.value.length > 0) {
      // 默认选中 admin（若有）
      userId.value = (users.value.find((u) => u.account === 'admin') ?? users.value[0]).id;
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  }
}

async function submit(): Promise<void> {
  if (!userId.value) {
    ElMessage.warning('请选择登录账号');
    return;
  }
  loading.value = true;
  try {
    await auth.login(userId.value, password.value);
    ElMessage.success(`欢迎回来，${auth.displayName}`);
    await router.replace('/workbench');
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  } finally {
    loading.value = false;
  }
}

onMounted(loadUsers);
</script>

<template>
  <div class="login-page">
    <div class="auth-shell rise">
      <!-- 视觉面：品牌与主张压在画面留白处，不与货架纹理重叠 -->
      <aside class="visual">
        <div class="visual-copy">
          <div class="brand">
            <span class="brand-mark">轻</span>
            <span class="brand-name">轻松进销存</span>
          </div>
          <h1 class="headline">
            进货、销售、库存、账目
            <br />
            一处看清
          </h1>
          <p class="subline">本地数据 · 离线可用 · 单据全程可追溯</p>
        </div>
      </aside>

      <section class="form-pane">
        <header class="form-head">
          <h2>登录</h2>
          <p>选择账号后即可进入系统，无需手动输入账号</p>
        </header>

        <el-form label-position="top" @submit.prevent>
          <el-form-item label="登录账号">
            <el-select
              v-model="userId"
              :placeholder="placeholder"
              filterable
              style="width: 100%"
              @visible-change="(open: boolean) => open && loadUsers()"
            >
              <el-option
                v-for="u in users"
                :key="u.id"
                :label="u.name === u.account ? u.account : `${u.name}（${u.account}）`"
                :value="u.id"
              />
            </el-select>
          </el-form-item>

          <el-form-item label="登录密码">
            <el-input
              v-model="password"
              type="password"
              show-password
              placeholder="默认管理员密码为空，直接登录"
              @keyup.enter="submit"
            />
          </el-form-item>

          <el-button type="primary" class="submit" :loading="loading" @click="submit">登 录</el-button>
        </el-form>

        <div class="tip">
          <span class="tip-row">
            当前账号：{{ selected ? `${selected.name}（${selected.account}）` : '未选择' }}
          </span>
          <span class="tip-row">
            首次使用请选择 admin，密码留空即可进入；如需口令请到「系统 → 用户与角色权限」设置
          </span>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  background: var(--bg);
  /* 极淡的品牌光晕，避免纯平背景显得单薄 */
  background-image: radial-gradient(circle at 18% 12%, color-mix(in srgb, var(--brand) 10%, transparent), transparent 42%);
}

.auth-shell {
  width: min(940px, 100%);
  height: min(600px, 100%);
  display: grid;
  grid-template-columns: 1.05fr 1fr;
  border-radius: 20px;
  overflow: hidden;
  background: var(--panel);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-lg);
}

/* 左侧视觉面：真实仓储静物照，顶部留白用于承载品牌与主张 */
.visual {
  position: relative;
  background-image:
    linear-gradient(180deg, rgba(255, 255, 255, 0.92) 0%, rgba(255, 255, 255, 0.55) 26%, rgba(255, 255, 255, 0) 46%),
    url('../assets/login-warehouse.jpg');
  background-size: cover;
  background-position: center 78%;
}

.visual-copy {
  position: absolute;
  inset: 0;
  padding: 34px 32px;
  display: flex;
  flex-direction: column;
  gap: 22px;
  color: #10151c;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.brand-mark {
  width: 30px;
  height: 30px;
  border-radius: 9px;
  background: var(--brand);
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}

.brand-name {
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.headline {
  margin: 0;
  font-size: 27px;
  line-height: 1.32;
  font-weight: 650;
  letter-spacing: -0.025em;
}

.subline {
  margin: 0;
  font-size: 12.5px;
  color: #4a5462;
  letter-spacing: 0.01em;
}

/* 右侧表单面 */
.form-pane {
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 40px 44px;
  border-left: 1px solid var(--border);
  background: var(--panel);
}

.form-head {
  margin-bottom: 26px;
}

.form-head h2 {
  margin: 0;
  font-size: 21px;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: var(--text);
}

.form-head p {
  margin: 6px 0 0;
  font-size: 12.5px;
  color: var(--text-3);
}

.submit {
  width: 100%;
  height: 38px;
  margin-top: 6px;
  font-size: 14px;
  letter-spacing: 0.08em;
}

.tip {
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.tip-row {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}

/* 深色主题下画面转为低亮度，文案同步切换为浅色，保持同一层级关系 */
html[data-theme='dark'] .visual {
  background-image:
    linear-gradient(180deg, rgba(14, 17, 22, 0.8) 0%, rgba(14, 17, 22, 0.5) 28%, rgba(14, 17, 22, 0.35) 46%),
    url('../assets/login-warehouse.jpg');
}

html[data-theme='dark'] .visual-copy {
  color: #e8ebef;
}

html[data-theme='dark'] .subline {
  color: #9aa4b2;
}

/* 窄窗口下改为单列，先展示表单，视觉面收为顶部横幅 */
@media (max-width: 860px) {
  .auth-shell {
    grid-template-columns: 1fr;
    grid-template-rows: 148px 1fr;
    height: min(660px, 100%);
  }

  .visual {
    background-position: center 62%;
  }

  .visual-copy {
    padding: 22px 24px;
    gap: 10px;
  }

  .headline {
    font-size: 21px;
  }

  .form-pane {
    border-left: none;
    border-top: 1px solid var(--border);
    padding: 30px 28px;
  }
}
</style>
