import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import { Config } from '@/Config';

import AppLogo from './AppLogo.vue';

describe('AppLogo', () => {
  it('shows the app name beside a decorative logo image', () => {
    const wrapper = mount(AppLogo);

    expect(wrapper.text()).toContain(Config.APP_NAME);
    expect(wrapper.get('img').attributes('alt')).toBe('');
  });
});
