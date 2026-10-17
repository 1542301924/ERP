<script setup lang="ts">
/**
 * 登录页：用户名下拉选择（无需输入账号）+ 口令。
 *
 * 内置 admin 口令为空，直接点「登录」即可进入；其余用户若设置了口令则需输入。
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
    <el-card class="login-card">
      <div class="brand">
        <div class="logo">轻</div>
        <div>
          <h2 class="name">轻松进销存</h2>
          <p class="slogan">让进货、销售、库存、账目一目了然</p>
        </div>
      </div>

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

      <p class="tip">
        当前账号：{{ selected ? `${selected.name}（${selected.account}）` : '未选择' }}
        <br />
        首次使用请选择 admin，密码留空即可进入；如需口令请到「系统 → 用户与角色权限」设置
      </p>
    </el-card>
  </div>
</template>

<style scoped>
.login-page {
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--el-bg-color-page);
}
.login-card {
  width: 400px;
  padding: 8px 12px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 24px;
}
.logo {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  background: var(--el-color-primary);
  color: #fff;
  font-size: 22px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}
.name {
  margin: 0;
  font-size: 20px;
  color: var(--el-text-color-primary);
}
.slogan {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.submit {
  width: 100%;
  margin-top: 4px;
}
.tip {
  margin: 20px 0 0;
  font-size: 12px;
  line-height: 1.8;
  color: var(--el-text-color-secondary);
}
</style>
