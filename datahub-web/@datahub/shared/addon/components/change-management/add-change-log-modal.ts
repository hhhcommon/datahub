import Component from '@glimmer/component';
import { IAddChangeLogModalProps } from '@datahub/shared/types/change-management/change-log';
import { action, setProperties, computed } from '@ember/object';
import { tracked } from '@glimmer/tracking';
import Changeset from 'ember-changeset';
import { task } from 'ember-concurrency';
import { ETask } from '@datahub/utils/types/concurrency';
import getActorFromUrn from '@datahub/data-models/utils/get-actor-from-urn';
import { ChangeLog } from '@datahub/shared/modules/change-log';
import { ValidatorFunc } from 'ember-changeset/types';
import { validateLength } from 'ember-changeset-validations/validators';
import lookupValidator from 'ember-changeset-validations';
import { PersonEntity } from '@datahub/data-models/entity/person/person-entity';
import { OwnerUrnNamespace } from '@datahub/data-models/constants/entity/dataset/ownership';

/**
 * Interface meant for assembling the different recipient types' count
 */
interface IEmailRecipientsCount {
  // Number of followers for the entity
  followers: number;
  // Number of owners for the entity
  owners: number;
  // Optional individual recipients being added on a per-email/notification basis
  individualRecipients: number;
  // Option group distribution lists being added on a per-email basis
  distributionLists: number;
}

interface IAddChangeLogModalArgs {
  // External handler method for handling the closing of the modal
  onCloseModal: () => void;
  // External handler method for handling the saving of data from the modal
  onSave: (savedInfo: IAddChangeLogModalProps) => Promise<void>;
  // External handler method for handling the sending of email for a `changeLog` which was previously only saved to the audit log
  onSendEmailOnly?: (
    recipients: Array<Com.Linkedin.DataConstructChangeManagement.NotificationRecipient>
  ) => Promise<void>;

  // The followers of the entity being supplied in as the recipients
  recipients?: Array<Com.Linkedin.DataConstructChangeManagement.NotificationRecipient>;

  // Optional argument to indicate if the modal needs to handle the sending of email for an existing log
  isSendingEmailOnly?: boolean;

  // Optional argument which is populated with a changelog when we want to display an existing log as part of the modal
  currentChangeLog?: ChangeLog;

  // number of owners in the the parent entity
  ownersCount: number;
}

/**
 * Each enum value represents a valid state that the modal might be in.
 * Since the modal is wizard based, each state represents different UI element values and user actions the states change
 */
enum ModalState {
  // The state where the modal is meant to save the information into the `Audit Log` only
  SaveOnly = 'save',
  // The state where the modal saves the infomration to the `Audit Log` and sends out an email as a notification
  SaveAndNotify = 'saveandNotify',
  // The temporary state of transition between `SaveOnly` and `SaveAndNotify`
  Transition = 'transition',
  // The state where the modal is in charge of sending the email for an existing change log
  EmailOnly = 'email'
}

/**
 * Types of optional recipients
 */
enum RecipientType {
  IndividualRecipient = 'individualRecipient',
  DistributionList = 'distributionList'
}

// Minimum number of characters required for Subject and Content to create the log
const MIN_CHAR_SUBJECT_AND_CONTENT = 10;
// Maximum number of characters allowed for change-log subject
const MAX_CHAR_SUBJECT = 240;
// Maximum number of characters allowed for change-log content
const MAX_CHAR_CONTENT = 2500;
// The className associated with this component declared for styling purposes in the template
export const baseModalClass = 'add-change-log';

/**
 *  Presentational component that is in charge of displaying a form
 *  letting the users fill in content required to generate a new ChangeLog.
 *
 *  Owners have the option of either saving the changeLog to the AuditLog only,
 *  or additionally also send it out to a group of recipients ( followers).
 *
 *  It performs the following functions
 *  1) Provides a way for Owners to enter details about a new change log that they wish to create
 *  2) Allows them to save / send an email to recipients
 *  3) Provides a preview of the notification that is to be sent out and allows them to add additional recipients if needed.
 *  4) Communicates the final information containing all the metadata required back to a container.
 */
export default class AddChangeLogModal extends Component<IAddChangeLogModalArgs> {
  /**
   * Attached to component for easier access from template.
   */
  baseModalClass = baseModalClass;

  /**
   * Attached to component for easier access from template
   */
  minCharSubjectAndContent: number = MIN_CHAR_SUBJECT_AND_CONTENT;

  /**
   * Attached to component for easier access from template.
   */
  maxCharSubject: number = MAX_CHAR_SUBJECT;

  /**
   * Attached to component for easier access from template.
   */
  maxCharContent: number = MAX_CHAR_CONTENT;

  recipientType: Record<string, string> = {
    individualRecipient: RecipientType.IndividualRecipient,
    distributionList: RecipientType.DistributionList
  };

  /**
   * The list of Additional recipients that a user chooses to add in the preview stage.
   */
  @tracked
  individualRecipients: Array<string> = [];

  /**
   * The list of Group distribution lists that a user chooses to add in the preview stage.
   */
  @tracked
  distributionLists: Array<string> = [];

  /**
   * Property representing the current state of the Modal
   */
  currentModalState: ModalState = this.args.isSendingEmailOnly ? ModalState.EmailOnly : ModalState.SaveOnly;

  /**
   * The text for the `Save` button of the modal
   */
  saveOrNextButtonText = this.args.isSendingEmailOnly ? 'Next' : 'Save';

  /**
   * Flag indicating if the modal is in Preview mode or not
   */
  @tracked
  isDisplayingPreviewModal = false;

  /**
   * Flag indicating if the modal is in the sending email only mode or not
   */
  @tracked
  isSendingEmailOnly = this.args.isSendingEmailOnly || false;

  /**
   * Ember changeset Validations for the subject and content text input fields
   */
  validators(): Record<string, ValidatorFunc | Array<ValidatorFunc>> {
    return {
      subject: [validateLength({ min: 10 })],
      content: [validateLength({ min: 10 })]
    };
  }

  /**
   * A hash of editable working properties representing the local state of this component
   */
  @tracked
  editableChangeset: Changeset<IAddChangeLogModalProps> = new Changeset(
    this.defaultChangeLogModalProps,
    lookupValidator(this.validators()),
    this.validators()
  );

  /**
   * Returns the default editable properties for the modal.
   * Serves as the starting model for the ChangeSet
   * Handy for resetting the modal upon cancel or a successful submission.
   */
  get defaultChangeLogModalProps(): IAddChangeLogModalProps {
    return {
      subject: '',
      content: '',
      sendEmail: false,
      recipients: this.args.recipients || []
    };
  }

  /**
   * Object that breaks down total email-recipients count into 4 categories to better communicate
   * the audience groups to the user as well as the number in each group.
   *
   * Note : For distribution lists we only display the number of groups, not the number of people in each group.
   */
  @computed('individualRecipients', 'distributionLists')
  get emailRecipientsCount(): IEmailRecipientsCount {
    const { recipients = [], ownersCount = 0 } = this.args;
    return {
      followers: Math.max(recipients.length - ownersCount, 0),
      owners: ownersCount,
      individualRecipients: this.individualRecipients.length,
      distributionLists: this.distributionLists.length
    };
  }

  /**
   * Count of all recipients together
   */
  @computed('emailRecipientsCount')
  get totalRecipientsCount(): number {
    return (
      this.emailRecipientsCount.followers +
      this.emailRecipientsCount.individualRecipients +
      this.emailRecipientsCount.owners
    );
  }

  /**
   * Returns a boolean indicating if the `Save` button is disabled incase the user enters
   * characters less than the minimum required for either Subject or Content
   */
  get isSaveDisabled(): boolean {
    // We enable the save if it the State is `EmailOnly`
    if (this.currentModalState === ModalState.EmailOnly) {
      return false;
    }
    return !(
      this.editableChangeset.get('subject').length >= this.minCharSubjectAndContent &&
      this.editableChangeset.get('content').length >= this.minCharSubjectAndContent
    );
  }

  /**
   * Formatting logic for parsing the recipients names into a meaningful human format that can be displayed onto the template.
   *
   * We display the first 5 followers in a Capitalized fashion then denote how many more are left (if any) with the `x more` notation.
   */
  get recipientsDisplayText(): string {
    const recipients = this.editableChangeset.get('recipients');
    const numberOfRecipients = this.editableChangeset.get('recipients')?.length || 0;
    const numberOfHiddenRecipients = numberOfRecipients - 5;

    if (numberOfRecipients > 0) {
      const baseDisplayText =
        recipients
          ?.slice(0, 5)
          .map(recipient => getActorFromUrn((recipient as { userUrn?: string }).userUrn || ''))
          .join(', ') || '';

      const additionalDisplayText = numberOfRecipients > 5 ? ` and ${numberOfHiddenRecipients} more` : '';
      return baseDisplayText.concat(additionalDisplayText);
    }
    return 'No followers found, email will be sent to owners only';
  }

  /**
   * Assembly logic for the preview mode's title text, which is dynamic based on how many individual recipients and DLs are added when creating a new log.
   */
  get titleText(): string {
    const { emailRecipientsCount, totalRecipientsCount } = this;
    const baseTitleText = `Sending Email to ${totalRecipientsCount} individuals`;
    const additionalTitleText =
      emailRecipientsCount.distributionLists > 0 ? ` and ${emailRecipientsCount.distributionLists} group(s)` : '';
    return baseTitleText.concat(additionalTitleText);
  }

  /**
   * The method responsible for setting all the local properties for each state
   */
  modalStateHandler(state: ModalState): void {
    switch (state) {
      case ModalState.SaveAndNotify:
        setProperties(this, {
          saveOrNextButtonText: 'Save log & send Email',
          currentModalState: ModalState.SaveAndNotify,
          isDisplayingPreviewModal: true
        });
        break;
      case ModalState.Transition:
        setProperties(this, {
          saveOrNextButtonText: 'Next',
          currentModalState: ModalState.Transition,
          isDisplayingPreviewModal: false
        });
        this.editableChangeset.set('sendEmail', true);
        break;
      case ModalState.SaveOnly:
        setProperties(this, {
          saveOrNextButtonText: 'Save',
          currentModalState: ModalState.SaveOnly,
          isSendingEmailOnly: false,
          isDisplayingPreviewModal: false
        });
        this.editableChangeset.set('sendEmail', false);
        break;
      case ModalState.EmailOnly:
        setProperties(this, {
          saveOrNextButtonText: 'Next',
          currentModalState: ModalState.EmailOnly,
          isDisplayingPreviewModal: false,
          isSendingEmailOnly: true
        });
        this.editableChangeset.set('sendEmail', true);
        break;
    }
  }

  /**
   * Async task responsible for handing off the recipients to the container to send email.
   */
  @(task(function*(this: AddChangeLogModal): IterableIterator<Promise<void>> {
    if (this.args.onSendEmailOnly) {
      const recipients = this.constructRecipients();
      ((yield this.args.onSendEmailOnly(recipients)) as unknown) as void;
    }
  }).drop())
  sendEmailOnlyTask!: ETask<void>;

  /**
   * Async task responsible for handing off the user entered information to the container component
   */
  @(task(function*(this: AddChangeLogModal): IterableIterator<Promise<void>> {
    const subject = this.editableChangeset.get('subject');
    const content = this.editableChangeset.get('content');
    const sendEmail = this.editableChangeset.get('sendEmail');
    const recipients = this.constructRecipients();
    ((yield this.args.onSave({ subject, content, sendEmail, recipients })) as unknown) as void;
    this.onResetModal();
  }).restartable())
  saveChangeLogTask!: ETask<void>;

  /**
   * Local helper method that constructs recipients.
   *
   * It handles both optional recipients and incoming recipients from the container
   */
  constructRecipients(): Array<Com.Linkedin.DataConstructChangeManagement.NotificationRecipient> {
    const recipients = this.editableChangeset.get('recipients') || [];
    // construct namespace of optional individual recipients if any
    const individualRecipients = this.individualRecipients.map(individualRecipient => ({
      userUrn: PersonEntity.urnFromUsername(individualRecipient)
    }));
    // construct namespace of optional distribution lists if any
    const distributionLists = this.distributionLists.map(distributionList => ({
      // TODO : Replace this line with helper from GroupEntity once META-12355 is completed.
      groupUrn: `${OwnerUrnNamespace.groupUser}:${distributionList}`
    }));
    // Append the optional individual recipients to the main recipients
    return [...recipients, ...individualRecipients, ...distributionLists];
  }

  /**
   * Closes the modal and resets the values of the `editedProps` to default
   */
  @action
  onResetModal(): void {
    this.editableChangeset.rollback();
    this.modalStateHandler(ModalState.SaveOnly);
    this.args.onCloseModal();
  }

  /**
   * Transitions state over to SaveAndNotify and also performs calling of the `SaveChangeLogTask`
   */
  @action
  async handleSaveOrNextClick(): Promise<void> {
    const { currentModalState } = this;
    if (currentModalState === ModalState.Transition || currentModalState === ModalState.EmailOnly) {
      this.modalStateHandler(ModalState.SaveAndNotify);
    } else if (currentModalState === ModalState.SaveAndNotify && this.isSendingEmailOnly) {
      await this.sendEmailOnlyTask.perform();
      this.onResetModal();
    } else {
      await this.saveChangeLogTask.perform();
      this.onResetModal();
    }
  }

  /**
   * Handles the modal state when `onSendEmail` button is selected
   */
  @action
  onSendEmailSelected(): void {
    this.currentModalState === ModalState.SaveOnly
      ? this.modalStateHandler(ModalState.Transition)
      : this.modalStateHandler(ModalState.SaveOnly);
  }

  /**
   * Function which handles the `back` click in the preview , transitions the ModalState over to `Transition`.
   * Results in the fields being populated with current values that the user has entered
   */
  @action
  onBackToAddModal(): void {
    this.modalStateHandler(ModalState.Transition);
  }

  /**
   * Method that appends a new recipient to the `individualRecipients` or the `distributedLists` property
   *
   * @param recipientName The LDAP/name of a recipient being added in by the user.
   * @param recipientType The type of the recipient being added
   */
  @action
  addRecipient(recipientType: string, recipientName: string): void {
    switch (recipientType) {
      case RecipientType.DistributionList:
        this.distributionLists.addObject(recipientName);
        break;
      case RecipientType.IndividualRecipient:
        this.individualRecipients.addObject(recipientName);
        break;
    }
  }

  /**
   * Method that removes an individual recipient or distributed list name from the Optional fields of recipients
   *
   * @param valueIndex The index of the recipient that is to be removed
   * @param recipientType The type of the recipient that is to be removed
   */
  @action
  removeRecipient(recipientType: string, valueIndex: number): void {
    switch (recipientType) {
      case RecipientType.DistributionList:
        const distributionList = this.distributionLists[valueIndex];
        this.distributionLists.removeObject(distributionList);
        break;
      case RecipientType.IndividualRecipient:
        const recipient = this.individualRecipients[valueIndex];
        this.individualRecipients.removeObject(recipient);
        break;
    }
  }
}
