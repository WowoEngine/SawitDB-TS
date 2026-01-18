/**
 * ConditionEvaluator
 * Evaluates conditions against data objects
 * Extracted from WowoEngine.js
 */
export default class ConditionEvaluator {
	constructor() {}

	checkMatch(obj, criteria) {
		if (!criteria) return true;

		if (criteria.type === "compound") {
			let result = criteria.logic === "OR" ? false : true;

			for (let i = 0; i < criteria.conditions.length; i++) {
				const cond = criteria.conditions[i];
				const matches =
					cond.type === "compound"
						? this.checkMatch(obj, cond)
						: this.checkSingleCondition(obj, cond);

				if (criteria.logic === "OR") {
					result = result || matches;
					if (result) return true; // Short circuit
				} else {
					result = result && matches;
					if (!result) return false; // Short circuit
				}
			}
			return result;
		}

		return this.checkSingleCondition(obj, criteria);
	}

	checkSingleCondition(obj, criteria) {
		const val = obj[criteria.key];
		const target = criteria.val;
		switch (criteria.op) {
			// Use strict equality with type-aware comparison
			case "=":
				// Handle numeric comparison (allows "5" === 5 scenario)
				if (typeof val === "number" || typeof target === "number") {
					return Number(val) === Number(target);
				}
				return val === target;
			case "!=":
				if (typeof val === "number" || typeof target === "number") {
					return Number(val) !== Number(target);
				}
				return val !== target;
			case ">":
				return val > target;
			case "<":
				return val < target;
			case ">=":
				return val >= target;
			case "<=":
				return val <= target;
			case "IN":
				return Array.isArray(target) && target.includes(val);
			case "NOT IN":
				return Array.isArray(target) && !target.includes(val);
			case "LIKE": {
				// Escape regex metacharacters except % and _ which are SQL wildcards
				const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				const regexStr =
					"^" + escaped.replace(/%/g, ".*").replace(/_/g, ".") + "$";
				const re = new RegExp(regexStr, "i");
				return re.test(String(val));
			}
			case "BETWEEN":
				return val >= target[0] && val <= target[1];
			case "IS NULL":
				return val === null || val === undefined;
			case "IS NOT NULL":
				return val !== null && val !== undefined;
			default:
				return false;
		}
	}
}
