<template>
  <ui-page-container>
    <ui-page-heading title="System config" subtitle="Settings that apply across the whole system." />

    <ui-card v-if="sysConfig" flush title="Authentication" subtitle="How people get access to this system.">
      <div class="divide-y divide-divider px-6">
        <ui-form-field
          v-slot="{ input }"
          layout="row"
          align="end"
          label="Registration"
          help="Let people create their own account from the sign-in page."
        >
          <ui-switch
            :value="sysConfig.registrationEnabled"
            v-bind="input"
            :loading="loading"
            @update:value="doSetRegistration"
          />
        </ui-form-field>
      </div>
    </ui-card>
  </ui-page-container>
</template>

<script setup lang="ts">
import { ref } from 'vue';

import { useResource } from '@/composables/useResource';

import { useLogService } from '@/services/LogService';
import { useSysConfigAdminService } from '@/services/api/admin/SysConfigAdminService';
import { useNotificationStore } from '@/stores/notification';

import { UiCard, UiFormField, UiPageContainer, UiPageHeading, UiSwitch } from '@/components/ui';

const logService = useLogService();
const logger = logService.createLogger('pages/loggedin/admin/SysConfig');

const notificationStore = useNotificationStore();
const sysConfigAdminService = useSysConfigAdminService();

const { data: sysConfig } = useResource({
  request: {},
  fetch: () => sysConfigAdminService.getSysConfig(),
});

const loading = ref(false);

const doSetRegistration = (registrationEnabled: boolean) => {
  if (sysConfig.value === null || loading.value) {
    return;
  }

  loading.value = true;

  sysConfigAdminService
    .updateSysConfig({ registrationEnabled })
    .then(() => {
      sysConfig.value = { registrationEnabled };
      notificationStore.addToast(
        registrationEnabled ? 'Registration opened' : 'Registration closed',
        registrationEnabled ? 'Anyone can create an account from the sign-in page.' : 'New accounts need an admin.'
      );
    })
    .finally(() => {
      loading.value = false;
    })
    .catch((error: unknown) => {
      logger.error({ error }, 'doSetRegistration(): Failed to update the system config');
    });
};
</script>
