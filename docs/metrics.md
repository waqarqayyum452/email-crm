# Metric definitions

All time filters apply in UTC at the database boundary. The dashboard displays business-local dates where appropriate. Filters for campaign and mailbox should apply consistently to the numerator and denominator. Test messages consume capacity but are excluded from production campaign performance. Empty denominators produce an unavailable/zero-safe display, never an invented percentage.

| Metric | Meaning | Rate denominator / caveat |
| --- | --- | --- |
| SMTP-accepted messages | Non-test outbound messages whose submission was accepted by SMTP | Counts messages/steps, not unique people; does not establish inbox placement |
| Failed attempts | Immutable temporary/permanent/authentication/provider-limit outcome events, including failures before a later successful retry | Each recorded unsuccessful submission/setup outcome counts; not a unique-recipient bounce rate |
| Unknown attempts | Submission acceptance cannot be determined | Separate from proven failure; held for reconciliation; do not count as accepted until resolved |
| Later delivery failures / bounces | Incoming delivery-status evidence of a failure after submission | Failure count / corresponding accepted messages for a comparable cohort; delayed reports may fall outside the original send interval |
| Unique estimated opens | Distinct non-test outbound message IDs with an eligible open event after filtering | Unique opened messages / open-tracking-enabled SMTP-accepted messages (`open_tracking_messages`) in the selected scope; privacy loads and blocked images limit accuracy |
| Unique estimated clicks | Distinct non-test outbound message IDs with an eligible tracked-link click | Unique clicked messages / click-tracking-enabled SMTP-accepted messages (`click_tracking_messages`) in the selected scope; scanners can visit links |
| Human replies | Matched inbound messages classified as human replies | Message count differs from unique replying contacts; a reply rate must explicitly deduplicate contacts and use contacted recipients as denominator |
| Automatic replies | Matched out-of-office/automatic responses | Separate count; no human-reply numerator, pause for review by default |
| Unsubscribes | Recorded opt-outs resulting in agency suppression | A displayed rate requires opt-out recipients / contacted recipients for the selected scope, not unrelated manual suppressions |
| Qualified leads | Contacts whose pipeline stage has qualified semantics | Current pipeline state is not a historical stage-transition count; stage movement is a deliberate CRM action |
| Won opportunities | Contacts currently in a pipeline stage with won semantics | Current agency snapshot, independent of date/campaign/mailbox filters; never inferred from an open/click |
| Active campaigns | Campaigns currently active | Snapshot of state, not messages in a date cohort |
| Sending capacity | Counted/reserved submissions in the preceding rolling 24 hours compared with configured application/provider caps | Initials, follow-ups, test sends and CRM replies consume capacity; external webmail usage is not comprehensively known |

The UI reports the backend's real stored aggregates; it does not seed demo analytics. The API exposes numerator/denominator data so percentage labels can be explicit. Counts of human-reply messages must not be relabeled unique reply rate: `reply_rate` uses distinct replying contacts / distinct accepted recipients. Qualified and won are current agency-wide stage totals, independent of date/campaign/mailbox filters. Event counts use event dates while accepted denominators use acceptance dates, so an event on a previously sent message can fall into a later interval; these are not strict sent-cohort rates and can exceed 100% in a narrow range. Compare cohorts before interpreting a percentage. Current qualified/won counts must not be presented as historical funnel conversion for a period unless historical transition evidence supports it.

An unknown attempt later reconciled as accepted uses the operator's verified provider acceptance timestamp when supplied. Without that evidence timestamp, the confirmation time is used conservatively for rolling capacity and follow-up timing. Its accepted count can therefore appear in the confirmation period; do not treat that timestamp as measured SMTP latency or a recovered delivery time. Unknown attempts remain separate until reconciled.

Raw tracking events are retained separately from deduplicated/filtered views. Filtering known scanner signatures is a heuristic and cannot authenticate a human. An email open does not prove reading, a click does not prove buying intent, and SMTP alone cannot establish comprehensive delivery success.
