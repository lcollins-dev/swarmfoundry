<template>
  <ui-card class="mx-auto mt-10 max-w-sm">
    <ui-form-heading title="Create your account" subtitle="You'll be signed in as soon as it's ready." />

    <ui-form :name="FORM_NAME" @submit="doRegister">
      <ui-form-field v-slot="{ input }" label="Name" path="name">
        <ui-input
          v-model:value="registerForm.name"
          v-bind="input"
          name="name"
          autocomplete="name"
          placeholder="Your name"
        />
      </ui-form-field>

      <ui-form-field v-slot="{ input }" label="Email" path="email">
        <ui-input
          v-model:value="registerForm.email"
          v-bind="input"
          type="email"
          name="email"
          autocomplete="email"
          placeholder="you@example.com"
        />
      </ui-form-field>

      <ui-form-field v-slot="{ input }" label="Password" path="password">
        <ui-input
          v-model:value="registerForm.password"
          v-bind="input"
          type="password"
          name="password"
          autocomplete="new-password"
          placeholder="New password"
        />
      </ui-form-field>

      <ui-form-field v-slot="{ input }" label="Confirm password" path="confirmPassword">
        <ui-input
          v-model:value="registerForm.confirmPassword"
          v-bind="input"
          type="password"
          name="confirm-password"
          autocomplete="new-password"
          placeholder="Enter it again"
        />
      </ui-form-field>

      <ui-button type="primary" native-type="submit" block :loading="loading">Create Account</ui-button>
    </ui-form>

    <p class="mb-0 mt-4 text-center text-muted">
      Already have an account?
      <ui-link to="/sign-in">Sign in</ui-link>
    </p>
  </ui-card>
</template>

<script setup lang="ts">
import { reactive, ref, watchEffect } from 'vue';
import { useRouter } from 'vue-router';

import type { RegisterRequestDto } from '@libs/dto';

import { passwordMismatchError } from '@/utils/password';

import { useLogService } from '@/services/LogService';
import { useUserService } from '@/services/api/UserService';
import { useErrorStore } from '@/stores/error';
import { useUserStore } from '@/stores/user';

import { UiButton, UiCard, UiForm, UiFormField, UiFormHeading, UiInput, UiLink } from '@/components/ui';

const FORM_NAME = 'register';

const logService = useLogService();
const logger = logService.createLogger('pages/loggedout/Register');

interface IRegisterForm extends RegisterRequestDto {
  confirmPassword: string;
}

const router = useRouter();

const errorStore = useErrorStore();
const userStore = useUserStore();
const userService = useUserService();

const registerForm = reactive<IRegisterForm>({
  name: '',
  email: '',
  password: '',
  confirmPassword: '',
});

const loading = ref(false);

const doRegister = () => {
  if (loading.value) {
    return;
  }

  if (registerForm.password !== registerForm.confirmPassword) {
    errorStore.setValidationError(passwordMismatchError(FORM_NAME));
    return;
  }

  const registerRequest: RegisterRequestDto = {
    name: registerForm.name.trim(),
    email: registerForm.email.trim(),
    password: registerForm.password,
  };

  loading.value = true;

  userService
    .register(registerRequest, FORM_NAME)
    .finally(() => {
      loading.value = false;
    })
    .catch((error: unknown) => {
      logger.error({ error }, 'doRegister(): Failed to register');
    });
};

watchEffect(() => {
  if (userStore.canRegister === false) {
    router.push('/sign-in').catch((error: unknown) => {
      logger.error({ error }, 'watchEffect(): Failed to navigate to sign in page');
    });
  }
});
</script>
