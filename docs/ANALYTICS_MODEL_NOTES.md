# LineupJD Analytics Model Notes

## Recommended core model

Use a **Bayesian hierarchical Poisson goal-rate model** as the primary team-specific learning model.

The model should operate on lineup **stints**: uninterrupted periods during which the on-field players and positions remain unchanged. Each stint records its duration, player-position assignments, goals for, goals against, score state, and available context.

Model goals for and goals against separately, using stint duration as exposure. From those two rates, derive:

- Expected goals for
- Expected goals against
- Expected score margin
- Win, draw, and loss probabilities
- Lineup recommendations for different coaching objectives

## Why this is the starting model

- Goals are rare count events, which Poisson models are designed to handle.
- Every scoreless minute remains useful exposure data.
- Bayesian shrinkage keeps small-sample estimates close to neutral.
- The hierarchy can share information across players, positions, teams, formats, and eventually the full platform.
- Results naturally include uncertainty rather than false precision.
- Player and position contributions are directly interpretable without SHAP.

## Factors the model may evaluate

### Coach-controlled decisions

- Players on the field
- Player positions
- Formation
- Player combinations
- Substitution timing
- Planned playing time

### Context used to compare decisions fairly

- Opponent strength
- Home or away
- Current score
- Time remaining
- Rest between games
- Accumulated player minutes and estimated fatigue
- Weather and time of day
- Match type: official, friendly, or scrimmage

### Outcomes

- Goals for
- Goals against
- Score margin
- Win, draw, or loss

LineupJD should not require shots, assists, crosses, corners, passes, tackles, or player ratings. Its core question is how coach-controlled deployment decisions relate to team results.

## Optional faster signal: team attempt rate

Goals remain the primary outcome, but LineupJD may optionally track **team shot attempts for and against** as a separate, denser learning signal. No shooter or defender identity is required: the players already on the field are automatically associated with the event through the current lineup stint.

Use one simple, consistent definition:

> A shot attempt is an intentional attempt toward goal, including a goal, saved shot, blocked shot, or shot off target.

This produces two distinct analyses:

1. **Goal model:** lineup -> goals for and against. This remains the measure of actual scoring results and must not depend on attempt data.
2. **Attempt model:** lineup -> attempts for and against. This estimates which arrangements create attacking pressure or suppress the opponent's pressure.

From the attempt model, calculate:

- Attempts for per 60 minutes
- Attempts against per 60 minutes
- Attempt differential
- Supported lineup, player, position, and combination effects on pressure

Because attempts occur much more frequently than goals, attempt-rate findings can emerge materially sooner. If attempts occur five times as often, an idealized Poisson estimate of the **attempt rate itself** may reach a similar event count in roughly one-fifth of the playing time. It does **not** mean five times faster knowledge about goals or five times the statistical precision; five times as many comparable observations gives roughly the square root of five, or about 2.2 times, the precision under ideal assumptions. Real gains will be smaller because attempts are correlated and manually recorded.

Attempts are useful only if the coach cares about pressure as an outcome in its own right. They should not silently replace goals as the target or cause the recommendation engine to assume that more attempts always produce better scores. A later explanatory check can measure whether this team's attempt rate actually predicts its goal rate.

Do not require attempt tracking for a game to be complete. The low-friction default remains lineup changes plus goals for and against.

## Recommendation objectives

The coach chooses the objective; the model identifies the supported lineup best suited to it.

- **Attack:** maximize expected goals for, regardless of defensive risk.
- **Balanced:** maximize expected score margin.
- **Protect:** minimize expected goals against.
- **Chase Result:** maximize the probability of tying or winning given the score and time remaining.
- **Pressure:** maximize expected attempt differential.
- **Create Attempts:** maximize expected attempts for.
- **Suppress Attempts:** minimize expected attempts against.
- **Development:** balance playing time and position experience while showing predicted competitive tradeoffs.

The pressure modes are available only when the team consistently records attempts. Goal-based recommendations and attempt-based recommendations must be labeled separately so a coach can understand the tradeoff.

## Supporting methods

The Bayesian goal model is the core, but a few supporting methods are still needed:

1. **Deterministic stint reconstruction**
   Rebuild every lineup period from the event log so corrections recalculate all minutes and outcomes.

2. **Hierarchical player and position effects**
   Estimate an overall player effect first, then position-specific deviations with stronger shrinkage.

3. **Sparse pair interactions**
   Add player-pair synergy only after sufficient shared and separate minutes. Unsupported pair estimates remain near neutral or hidden.

4. **Posterior score simulation**
   Simulate goals from the estimated goals-for and goals-against rates to calculate expected margin and win/draw/loss probabilities.

5. **Leave-one-match-out validation**
   Test whether a finding survives removal of any single match and whether predictions beat simple team-average baselines.

6. **Data-readiness checks**
   Base insight readiness on minutes, goal events, lineup variation, matches represented, and sensitivity to one unusual game—not only the number of games.

## Possible model upgrades

Do not add complexity until validation shows it is needed.

- If goal counts are more variable than a Poisson model expects, test a **negative-binomial goal model**.
- If goals for and against need to be modeled jointly, test a **bivariate Poisson model**.
- If exact goal timing becomes important, a **piecewise survival or event-hazard model** is a later option; the initial exposure-based Poisson model is simpler and closely related.
- Once LineupJD has thousands of matches across teams, use **XGBoost with SHAP** for global nonlinear context patterns such as weather, rest, game format, and substitution timing. Keep small-sample team/player effects in the hierarchical model.

## Small-data expectations

LineupJD may have only eight matches for a team. It should therefore provide progressive results:

- Game 1: exact minutes, positions, lineup timeline, and players present for each goal.
- Games 2–3: descriptive on-field rates and clearly labeled early signals.
- Games 3–5: supported position and recurring-combination observations.
- Games 5–8: regularized individual estimates and only well-supported pair signals.

The system should find the strongest supported patterns, not promise every possible correlation. A pattern may reflect an unobserved quality such as leadership, communication, positioning, or morale, but LineupJD should report the observed association rather than inventing the reason.

## Public explanation

> **LineupJD uses a learning goal model to connect who played, where, and when with goals for and against. It becomes more informed with every game while remaining cautious when evidence is limited.**

## Core product boundary

> **Recommend arrangements, not player actions.**

LineupJD optimizes player deployment. It measures the results produced when technical coaching is applied, but it does not attempt to replace technical coaching or tell players to shoot, pass, cross, or tackle more.

## Player recognition data is separate

The coach may optionally record who scored or attempted a shot for player history, praise, and season statistics. That identity is metadata for the player record, not an input to lineup-impact recommendations. The analytical event remains valid even when no player is identified.

> **The lineup receives analytical credit; the player receives historical recognition.**
