"""Sinclair (hero_magician).

Assumptions:
- Vexing Bolt: damage grows linearly from MinDamage to MaxDamage over MaxDamageTime of flight; flight time is
  distance / InitialProjectileVelocity (no redirect detours). While the Assistant is out it also fires a bolt for
  CloneDamagePercentage of the damage. T1 fire-rate slow applied to the target.
- Spectral Assistant: lasts AbilityDuration; every trigger pull of Sinclair's gun makes it attack once for Damage
  (spirit, assumed to always hit: it is an auto-aimed turret). T3 BonusFireRate is read as the Assistant's
  attack rate (doubtful: could be Sinclair's own fire rate). Casting it reloads Sinclair's weapon.
- Rabbit Hex: after DetonationDelay the target is a rabbit for HexDuration: it can't shoot or cast (stun) and
  takes DamageAmpPercentage more damage. Skillshot: both are scaled by spirit accuracy.
- Audience Participation: copies the enemy's ultimate (with this ability's upgrade tier) and Sinclair casts the
  copy as soon as its own cast condition is met within CopiedUltWindow.
"""
import copy

from deadsim.abilities import AbilityImpl, AbilityState, register
from deadsim.data import UNITS_PER_METER

ASSISTANT_KEY = "sinclair_assistant_until"


@register("ability_magician_magicbolt")
class VexingBolt(AbilityImpl):
    kind = "skillshot"

    def cast(self, c):
        delay = c.raw("AbilityCastDelay")
        c.lock_gun(delay + c.raw("AbilityPostCastDuration"))
        speed = c.raw("InitialProjectileVelocity", 800) / UNITS_PER_METER
        flight = c.dist / max(1.0, speed)
        x = min(1.0, flight / max(0.1, c.raw("MaxDamageTime", 2.0)))
        lo, hi = c.val("MinDamage"), c.val("MaxDamage")
        dmg = lo + (hi - lo) * x
        c.spirit_hit(dmg, delay=delay + flight)
        if c.now < c.me.counters.get(ASSISTANT_KEY, -1):
            c.spirit_hit(dmg * c.raw("CloneDamagePercentage") / 100, delay=delay + flight + c.raw("CloneBoltDelay"),
                         name="Vexing Bolt (Assistant)")
        if c.raw("FireRateSlow"):
            acc = c.me.skill.spirit_accuracy
            c.debuff("fire_rate_slow", c.raw("FireRateSlow") / 100 * acc, c.dur("DebuffDuration"), delay=delay + flight)


@register("ability_magician_cloneturret")
class SpectralAssistant(AbilityImpl):
    kind = "target"

    def cast(self, c):
        delay = c.raw("AbilityCastDelay")
        c.lock_gun(delay)
        c.me.clip = c.me.st.clip
        c.me.counters[ASSISTANT_KEY] = c.now + delay + c.dur("AbilityDuration")
        c.state["owed"] = 0.0

    def on_shot(self, c, shot):
        if c.now >= c.me.counters.get(ASSISTANT_KEY, -1) or not c.foe.alive:
            return
        st = c.state
        st["owed"] = st.get("owed", 0.0) + 1.0 + c.raw("BonusFireRate") / 100
        n = int(st["owed"])
        st["owed"] -= n
        if n:
            c.engine.damage(c.me, c.foe, c.val("Damage") * n, "spirit", self.s.ab.name, is_ability=True, ability=self.s)


@register("ability_magician_animalhexarea")
class RabbitHex(AbilityImpl):
    kind = "skillshot"

    def cast(self, c):
        delay = c.raw("AbilityCastDelay")
        c.lock_gun(delay)
        t = delay + c.raw("DetonationDelay", 0.9)
        acc = c.me.skill.spirit_accuracy
        d = c.dur("HexDuration")
        c.debuff("stun", 1, d * acc, delay=t)
        c.debuff("damage_taken_amp", c.val("DamageAmpPercentage") / 100 * acc, d, delay=t)


@register("ability_magician_copyult")
class AudienceParticipation(AbilityImpl):
    kind = "target"

    def cast(self, c):
        delay = c.raw("AbilityCastDelay")
        c.lock_gun(delay)
        foe_ult = next((a for a in c.foe.abilities if a.ab.ultimate), None)
        if foe_ult is None or foe_ult.ab.class_name == self.s.ab.class_name:   # nothing useful to copy
            return
        ab = copy.copy(foe_ult.ab)
        ab.name = f"{self.s.ab.name} ({ab.name})"
        cp = AbilityState(c.me, ab, tier=c.tier, unlocked=True)
        cp.start()
        until = c.now + c.dur("CopiedUltWindow", 9.0)
        c.after(delay + 0.1, self.try_copy, c, cp, until)

    def try_copy(self, c, cp, until):
        f = c.me
        if not (f.alive and c.foe.alive) or c.now > until:
            return
        if f.can_cast() and cp.impl.kind != "passive" and cp.impl.should_cast(cp.ctx):
            cp.cast()
            return
        cp.scratch.pop("_reach_delay", None)   # same as try_cast: a gate that passed inside a failed condition leaves no wait
        c.after(0.1, self.try_copy, c, cp, until)
