import { InitialDBStructure1596747468000 } from './1596747468000-InitialDBStructure';
import { InitialDBEntries1596966611000 } from './1596966611000-InitialDBEntries';
import { AddTasks1791989380438 } from './1791989380438-AddTasks';
import { AddTaskEndReasons1792007905159 } from './1792007905159-AddTaskEndReasons';
import { AddConfigRevisions1792530607877 } from './1792530607877-AddConfigRevisions';
import { AddScheduledTasks1792617050504 } from './1792617050504-AddScheduledTasks';
import { AddMergeRequestTasks1792701850067 } from './1792701850067-AddMergeRequestTasks';
import { AddTaskSteps1792785807242 } from './1792785807242-AddTaskSteps';
import { AddFailureSteps1792847300436 } from './1792847300436-AddFailureSteps';
import { AddDeploymentFaults1792875638456 } from './1792875638456-AddDeploymentFaults';
import { AddIssueWatermarks1792895754388 } from './1792895754388-AddIssueWatermarks';
import { KeyTasksOnIssueChanges1792945285781 } from './1792945285781-KeyTasksOnIssueChanges';
import { AddRunUsage1792968532047 } from './1792968532047-AddRunUsage';
import { TestData9000000000000 } from './test/9000000000000-TestData';

export const migrations = [
  InitialDBStructure1596747468000,
  InitialDBEntries1596966611000,
  AddTasks1791989380438,
  AddTaskEndReasons1792007905159,
  AddConfigRevisions1792530607877,
  AddScheduledTasks1792617050504,
  AddMergeRequestTasks1792701850067,
  AddTaskSteps1792785807242,
  AddFailureSteps1792847300436,
  AddDeploymentFaults1792875638456,
  AddIssueWatermarks1792895754388,
  KeyTasksOnIssueChanges1792945285781,
  AddRunUsage1792968532047,
];
export const testMigrations = [TestData9000000000000];
