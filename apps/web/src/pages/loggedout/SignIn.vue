<template>
  <ui-card class="mx-auto mt-10 max-w-sm">
    <ui-form v-if="step === 'email'" :name="FORM_NAME" @submit="doContinue">
      <ui-form-heading :title="`Sign in to ${Config.APP_NAME}`" subtitle="Use your email and password to continue." />

      <ui-form-field v-slot="{ input }" label="Email" path="email">
        <ui-input
          v-model:value="loginRequest.email"
          v-bind="input"
          type="email"
          name="email"
          autocomplete="username"
          placeholder="you@example.com"
        />
      </ui-form-field>

      <ui-button type="primary" native-type="submit" block>Continue</ui-button>
    </ui-form>

    <ui-form v-else :name="FORM_NAME" @submit="doLogin">
      <ui-form-heading title="Enter your password" />

      <ui-identity-pill class="mb-6 mt-3.5" :disabled="loading" @change="doChangeEmail">
        {{ loginRequest.email }}
      </ui-identity-pill>

      <!-- Lets a password manager pair the password with the email from the first step. -->
      <input
        class="hidden"
        type="email"
        autocomplete="username"
        :value="loginRequest.email"
        tabindex="-1"
        aria-hidden="true"
        readonly
      />

      <ui-form-field v-slot="{ input }" label="Password" path="password">
        <ui-input
          v-model:value="loginRequest.password"
          v-bind="input"
          type="password"
          name="password"
          autocomplete="current-password"
          placeholder="Your password"
        />
      </ui-form-field>

      <ui-button type="primary" native-type="submit" block :loading="loading">
        {{ loading ? 'Signing in...' : 'Sign In' }}
      </ui-button>
    </ui-form>

    <p v-if="userStore.canRegister" class="mb-0 mt-4 text-center text-muted">
      No account yet?
      <ui-link to="/register">Create one</ui-link>
    </p>
  </ui-card>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';

import type { LoginRequestDto } from '@libs/dto';

import { ValidationError } from '@/types/error';

import { Config } from '@/Config';

import { useLogService } from '@/services/LogService';
import { useUserService } from '@/services/api/UserService';
import { useErrorStore } from '@/stores/error';
import { useUserStore } from '@/stores/user';

import { UiButton, UiCard, UiForm, UiFormField, UiFormHeading, UiIdentityPill, UiInput, UiLink } from '@/components/ui';

const FORM_NAME = 'sign-in';

const logService = useLogService();
const logger = logService.createLogger('pages/loggedout/SignIn');

const errorStore = useErrorStore();
const userStore = useUserStore();
const userService = useUserService();

const step = ref<'email' | 'password'>('email');

const loginRequest = reactive<LoginRequestDto>({
  email: '',
  password: '',
});

const loading = ref(false);

// The browser's own `type="email"` check, which is looser than the api's, so the api still has the final say.
const isEmailShaped = (value: string): boolean => {
  const probe = document.createElement('input');
  probe.type = 'email';
  probe.value = value;

  return !probe.validity.typeMismatch;
};

// Moving to the password step makes no request, so the email is checked here first. The api checks it again at sign in.
const emailProblem = (email: string): string | null => {
  if (email === '') {
    return 'Enter your email address.';
  }

  return isEmailShaped(email) ? null : 'Enter a valid email address.';
};

const doContinue = () => {
  loginRequest.email = loginRequest.email.trim();

  const problem = emailProblem(loginRequest.email);

  if (problem !== null) {
    errorStore.setValidationError(new ValidationError(FORM_NAME, { email: { message: problem } }));
    return;
  }

  errorStore.clearValidationError();
  step.value = 'password';
};

const doChangeEmail = () => {
  errorStore.clearValidationError();
  loginRequest.password = '';
  step.value = 'email';
};

const doLogin = () => {
  if (loading.value) {
    return;
  }

  loading.value = true;

  userService
    .login({ email: loginRequest.email, password: loginRequest.password }, FORM_NAME)
    .finally(() => {
      loading.value = false;
    })
    .catch((error: unknown) => {
      // The email field, and so its refusal, shows only on the first step.
      if (errorStore.getFieldError(FORM_NAME, 'email') !== undefined) {
        step.value = 'email';
      }

      logger.error({ error }, 'doLogin(): Failed to login');
    });
};
</script>
