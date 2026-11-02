import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import IconBolt from '~icons/material-symbols/bolt-outline-rounded';

import KpiTile from './KpiTile.vue';

describe('UiKpiTile', () => {
  it('shows its label, icon, value and unit', () => {
    const tile = mount(KpiTile, { props: { label: 'Triggers', icon: IconBolt, value: 4, unit: 'configured' } });

    expect(tile.text()).toContain('Triggers');
    expect(tile.get('[data-testid="kpi-value"]').text()).toBe('4configured');
    expect(tile.find('svg').exists()).toBe(true);
  });

  it('shares the bar out by each band against the others, leaving out empty ones', () => {
    const tile = mount(KpiTile, {
      props: {
        label: 'Active now',
        value: 3,
        bands: [
          { tone: 'primary', weight: 3 },
          { tone: 'muted', weight: 0 },
          { tone: 'warning', weight: 4 },
        ],
      },
    });

    const bands = tile.get('[data-testid="kpi-bands"]').findAll('span');

    expect(bands.map(band => band.attributes('style'))).toEqual(['flex-grow: 3;', 'flex-grow: 4;']);
    expect(bands.map(band => band.classes())).toEqual([
      expect.arrayContaining(['bg-primary']),
      expect.arrayContaining(['bg-warning']),
    ]);
  });

  it('marks each legend item with a dot in its tone', () => {
    const tile = mount(KpiTile, {
      props: {
        label: 'Success · 7d',
        value: '79%',
        legend: [
          { label: '26 succeeded', tone: 'success' },
          { label: '7 failed', tone: 'error' },
        ],
      },
    });

    expect(tile.text()).toContain('26 succeeded');
    expect(tile.findAll('.size-1\\.5').map(dot => dot.classes())).toEqual([
      expect.arrayContaining(['bg-success']),
      expect.arrayContaining(['bg-error']),
    ]);
  });
});
