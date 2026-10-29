<template>
  <ui-card class="mx-auto mt-10 max-w-sm">
    <ui-form :name="FORM_NAME" @submit="doFinishSetup">
      <ui-form-heading title="Set up your account" subtitle="Choose the email and password you'll sign in with." />

      <ui-notice class="mb-6" type="warning" title="You're using the default admin account">
        Its password is in the docs, so anyone could use it. Set your own to continue.
      </ui-notice>

      <ui-form-field v-slot="{ input }" label="Name" path="name">
        <ui-input
          v-model:value="setupForm.name"
          v-bind="input"
          name="name"
          autocomplete="name"
          placeholder="Your name"
          :disabled="loading"
        />
      </ui-form-field>

      <ui-form-field
        v-slot="{ input }"
        label="Email"
        help="You'll sign in with this. Change it to your own address."
        path="email"
      >
        <ui-input
          v-model:value="setupForm.email"
          v-bind="input"
          type="email"
          name="email"
          autocomplete="username"
          :disabled="loading"
        />
      </ui-form-field>

      <ui-form-field v-slot="{ input }" label="New password" path="password">
        <ui-input
          v-model:value="setupForm.password"
          v-bind="input"
          type="password"
          name="new-password"
          autocomplete="new-password"
          placeholder="New password"
          :disabled="loading"
        />
      </ui-form-field>

      <ui-form-field v-slot="{ input }" label="Confirm password" path="confirmPassword">
        <ui-input
          v-model:value="setupForm.confirmPassword"
          v-bind="input"
          type="password"
          name="confirm-password"
          autocomplete="new-password"
          placeholder="Enter it again"
          :disabled="loading"
        />
      </ui-form-field>

      <div class="flex justify-between gap-2">
        <ui-button type="text" :disabled="loading" @click="doSignOut">Sign Out</ui-button>
        <ui-button type="primary" native-type="submit" :loading="loading">Save and Continue</ui-button>
      </div>
    </ui-form>
  </ui-card>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import type { UpdateProfileRequestDto } from '@libs/dto';

import { passwordMismatchError } from '@/utils/password';

import { useLogService } from '@/services/LogService';
import { useUserService } from '@/services/api/UserService';
import { useErrorStore } from '@/stores/error';
import { useNotificationStore } from '@/stores/notification';
import { useUserStore } from '@/stores/user';

import { UiButton, UiCard, UiForm, UiFormField, UiFormHeading, UiInput, UiNotice } from '@/components/ui';

import { HOME_PATH } from '@/router/middleware/auth';

const FORM_NAME = 'setup';

const logService = useLogService();
const logger = logService.createLogger('pages/loggedin/FirstTimeSetup');

interface ISetupForm extends Required<UpdateProfileRequestDto> {
  confirmPassword: string;
}

const router = useRouter();

const errorStore = useErrorStore();
const notificationStore = useNotificationStore();
const userStore = useUserStore();
const userService = useUserService();

const setupForm = reactive<ISetupForm>({
  name: '',
  email: '',
  password: '',
  confirmPassword: '',
});

const loading = ref(false);

watch(
  () => [userStore.profile?.name ?? '', userStore.profile?.email ?? ''],
  ([profileName, profileEmail]) => {
    setupForm.name = profileName;
    setupForm.email = profileEmail;
  },
  { immediate: true }
);

const finishSetup = async () => {
  await userService.updateProfile(
    { name: setupForm.name.trim(), email: setupForm.email.trim(), password: setupForm.password },
    FORM_NAME
  );

  setupForm.password = '';
  setupForm.confirmPassword = '';

  await router.push(HOME_PATH);
  notificationStore.addToast('Account set up', 'Sign in with your new email and password from now on.');
};

const doFinishSetup = () => {
  if (loading.value) {
    return;
  }

  if (setupForm.password !== setupForm.confirmPassword) {
    errorStore.setValidationError(passwordMismatchError(FORM_NAME));
    return;
  }

  loading.value = true;

  finishSetup()
    .finally(() => {
      loading.value = false;
    })
    .catch((error: unknown) => {
      logger.error({ error }, 'doFinishSetup(): Failed to finish setup');
    });
};

const doSignOut = () => {
  userService.logout().catch((error: unknown) => {
    logger.error({ error }, 'doSignOut(): Sign out failed');
  });
};
</script>
