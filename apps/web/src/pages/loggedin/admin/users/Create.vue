<template>
  <ui-page-container>
    <ui-page-heading
      title="New user"
      subtitle="Create an account and choose what it can do."
      back-to="/admin/users"
      back-label="Users"
    />

    <ui-form :name="CREATE_FORM" layout="row" @submit="doCreateUser">
      <ui-card title="Account" subtitle="They sign in with this email and password.">
        <ui-form-field v-slot="{ input }" label="Display name" help="Shown in their header." path="name">
          <ui-input
            v-model:value="name"
            v-bind="input"
            name="display-name"
            placeholder="Their name"
            :disabled="loading"
          />
        </ui-form-field>

        <ui-form-field v-slot="{ input }" label="Email" help="Used to sign in." path="email">
          <ui-input
            v-model:value="email"
            v-bind="input"
            type="email"
            name="email"
            autocomplete="off"
            placeholder="name@example.com"
            :disabled="loading"
          />
        </ui-form-field>

        <ui-form-field v-slot="{ input }" label="Password" path="password">
          <ui-input
            v-model:value="password"
            v-bind="input"
            type="password"
            name="new-password"
            autocomplete="new-password"
            placeholder="Their password"
            :disabled="loading"
          />
        </ui-form-field>

        <ui-form-field v-slot="{ input }" label="Confirm password" path="confirmPassword">
          <ui-input
            v-model:value="confirmPassword"
            v-bind="input"
            type="password"
            name="confirm-password"
            autocomplete="new-password"
            placeholder="Enter it again"
            :disabled="loading"
          />
        </ui-form-field>

        <ui-form-field
          v-slot="{ input }"
          label="Roles"
          help="Each role opens an admin area to them."
          path="userRoleIds"
        >
          <role-select v-model:value="roleIds" v-bind="input" name="roles" :disabled="loading" />
        </ui-form-field>

        <template #footer>
          <ui-button type="primary" native-type="submit" :loading="loading">Create User</ui-button>
        </template>
      </ui-card>
    </ui-form>
  </ui-page-container>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';

import { passwordMismatchError } from '@/utils/password';

import { useLogService } from '@/services/LogService';
import { useUserAdminService } from '@/services/api/admin/UserAdminService';
import { useErrorStore } from '@/stores/error';
import { useNotificationStore } from '@/stores/notification';

import { UiButton, UiCard, UiForm, UiFormField, UiInput, UiPageContainer, UiPageHeading } from '@/components/ui';
import RoleSelect from '@/components/user/RoleSelect.vue';

const CREATE_FORM = 'create-user';

const logService = useLogService();
const logger = logService.createLogger('pages/loggedin/admin/users/Create');

const router = useRouter();

const errorStore = useErrorStore();
const notificationStore = useNotificationStore();
const userAdminService = useUserAdminService();

const name = ref('');
const email = ref('');
const password = ref('');
const confirmPassword = ref('');
const roleIds = ref<number[]>([]);
const loading = ref(false);

const doCreateUser = () => {
  if (loading.value) {
    return;
  }

  if (password.value !== confirmPassword.value) {
    errorStore.setValidationError(passwordMismatchError(CREATE_FORM));
    return;
  }

  const createUserRequest = {
    name: name.value.trim(),
    email: email.value.trim(),
    password: password.value,
    userRoleIds: roleIds.value,
  };

  loading.value = true;

  userAdminService
    .createUser(createUserRequest, CREATE_FORM)
    .then(async userId => {
      notificationStore.addToast('User created', `${createUserRequest.name} can sign in now.`);

      await router.push(`/admin/users/${userId}`);
    })
    .finally(() => {
      loading.value = false;
    })
    .catch((error: unknown) => {
      logger.error({ error }, 'doCreateUser(): Failed to create the user');
    });
};
</script>
