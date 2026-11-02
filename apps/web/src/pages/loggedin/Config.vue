<template>
  <ui-page-container wide>
    <ui-page-heading title="Config" subtitle="The configuration and files that define your automation.">
      <ui-tag>Read-only</ui-tag>
      <ui-tag v-if="config">{{ revisionLabel }}</ui-tag>
    </ui-page-heading>

    <template v-if="config && configFile">
      <template v-if="selectedPath !== null">
        <ui-back-link :to="backLink.to" :label="backLink.label" />

        <ui-card v-if="selectedFile" :title="selectedFile.path" flush data-testid="config-selected-file">
          <config-file-view :content="selectedFile.content" />
        </ui-card>

        <ui-notice v-else type="warning" title="File unavailable" data-testid="config-file-missing">
          This file is not included in the current config.
        </ui-notice>
      </template>

      <template v-else>
        <ui-card :title="configFile.path" flush>
          <config-file-view
            :content="configFile.content"
            :trigger-names="triggerNames ?? []"
            :file-paths="referencedPaths"
          />
        </ui-card>

        <ui-card title="Referenced files" subtitle="Prompt, settings and instruction files used by this config." flush>
          <ui-list-row
            v-for="path of referencedPaths"
            :key="path"
            :title="path"
            :to="configFilePath(path)"
            data-testid="config-referenced-file"
          >
            <template #actions>
              <icon-chevron-right class="size-4 text-muted" />
            </template>
          </ui-list-row>

          <ui-empty v-if="referencedPaths.length === 0">No referenced files.</ui-empty>
        </ui-card>
      </template>
    </template>
  </ui-page-container>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import IconChevronRight from '~icons/material-symbols/chevron-right-rounded';

import { useBackLink } from '@/composables/useBackLink';
import { useResource } from '@/composables/useResource';

import { configFilePath } from '@/utils/configFile';
import { formatShortDayTime } from '@/utils/format/date';

import { useConfigAdminService } from '@/services/api/admin/ConfigAdminService';
import { useTriggerAdminService } from '@/services/api/admin/TriggerAdminService';

import ConfigFileView from '@/components/config/ConfigFileView.vue';
import {
  UiBackLink,
  UiCard,
  UiEmpty,
  UiListRow,
  UiNotice,
  UiPageContainer,
  UiPageHeading,
  UiTag,
} from '@/components/ui';

const route = useRoute();

const configAdminService = useConfigAdminService();
const triggerAdminService = useTriggerAdminService();

const { data: config } = useResource({ request: {}, fetch: () => configAdminService.getConfig() });

const { data: triggerNames } = useResource({
  request: {},
  fetch: () => triggerAdminService.getTriggerList().then(response => response.triggerList.map(listed => listed.name)),
});

// The API serves the config file first, then each file it references.
const configFile = computed(() => config.value?.files[0] ?? null);

const backLink = useBackLink(() => ({ to: '/config', label: configFile.value?.path ?? 'Config' }));
const referencedPaths = computed(() => (config.value?.files.slice(1) ?? []).map(file => file.path));

const selectedPath = computed(() => (typeof route.query.file === 'string' ? route.query.file : null));
const selectedFile = computed(
  () => config.value?.files.slice(1).find(file => file.path === selectedPath.value) ?? null
);

const revisionLabel = computed(() => {
  if (config.value === null) {
    return undefined;
  }

  const { sha, currentDate } = config.value;

  return sha === null || currentDate === null
    ? 'Local file'
    : `Revision ${sha.slice(0, 8)} · ${formatShortDayTime(currentDate)}`;
});
</script>
