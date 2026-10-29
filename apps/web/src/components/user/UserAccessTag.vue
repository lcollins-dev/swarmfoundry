<template>
  <ui-tag :type="isAdmin ? 'primary' : 'default'">{{ isAdmin ? 'Admin' : 'User' }}</ui-tag>
</template>

<script setup lang="ts">
import { computed, PropType } from 'vue';

import type { ListUserDto } from '@libs/dto';

import { UiTag } from '@/components/ui';

const props = defineProps({
  user: {
    type: Object as PropType<Pick<ListUserDto, 'userRoleIds'>>,
    required: true,
  },
});

// Any role makes an admin: every role the template defines grants an admin area.
const isAdmin = computed(() => props.user.userRoleIds.length > 0);
</script>
