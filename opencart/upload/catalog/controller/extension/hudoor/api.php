<?php
/**
 * حضور — نقطة استقبال حركات الحضور من تطبيق الأندرويد
 * index.php?route=extension/hudoor/api/ping
 * index.php?route=extension/hudoor/api/push
 */
class ControllerExtensionHudoorApi extends Controller {
	public function ping() {
		$body = $this->readBody();

		if ($body === null) {
			return;
		}

		$this->load->model('extension/hudoor/api');

		$this->output(200, array(
			'ok'       => true,
			'store'    => $this->config->get('config_name'),
			'received' => $this->model_extension_hudoor_api->countRecords()
		));
	}

	public function push() {
		$body = $this->readBody();

		if ($body === null) {
			return;
		}

		$this->load->model('extension/hudoor/api');

		$device = isset($body['device']) ? utf8_substr(trim((string)$body['device']), 0, 64) : '';

		// الموظفون
		if (isset($body['employees']) && is_array($body['employees'])) {
			$employees = array();

			foreach (array_slice($body['employees'], 0, 1000) as $e) {
				if (!is_array($e) || empty($e['id']) || !isset($e['name'])) {
					continue;
				}

				$employees[] = array(
					'id'   => utf8_substr((string)$e['id'], 0, 40),
					'name' => utf8_substr(trim((string)$e['name']), 0, 128),
					'code' => isset($e['code']) ? utf8_substr(trim((string)$e['code']), 0, 64) : ''
				);
			}

			$this->model_extension_hudoor_api->syncEmployees($employees, !empty($body['employees_full']));
		}

		// الحركات
		$saved = array();

		if (isset($body['records']) && is_array($body['records'])) {
			foreach (array_slice($body['records'], 0, 500) as $r) {
				if (!is_array($r) || empty($r['id']) || empty($r['empId']) || !isset($r['type']) || !in_array($r['type'], array('in', 'out'), true)) {
					continue;
				}

				$local = isset($r['local']) ? (string)$r['local'] : '';

				if (!preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/', $local)) {
					continue;
				}

				$this->model_extension_hudoor_api->addRecord(array(
					'record_id'     => utf8_substr((string)$r['id'], 0, 40),
					'employee_id'   => utf8_substr((string)$r['empId'], 0, 40),
					'employee_name' => utf8_substr(trim(isset($r['empName']) ? (string)$r['empName'] : ''), 0, 128),
					'employee_code' => utf8_substr(trim(isset($r['empCode']) ? (string)$r['empCode'] : ''), 0, 64),
					'type'          => $r['type'],
					'time_local'    => $local,
					'ts'            => isset($r['ts']) ? (float)$r['ts'] : 0,
					'device'        => $device
				));

				$saved[] = (string)$r['id'];
			}
		}

		$this->output(200, array('ok' => true, 'saved' => $saved));
	}

	/** يقرأ الطلب ويتحقق من المفتاح. يرجع null إذا تم الرد بخطأ. */
	private function readBody() {
		if (isset($this->request->server['REQUEST_METHOD']) && $this->request->server['REQUEST_METHOD'] == 'OPTIONS') {
			$this->output(200, array('ok' => true));
			return null;
		}

		if (!$this->config->get('module_hudoor_status')) {
			$this->output(403, array('ok' => false, 'error' => 'disabled', 'message' => 'استقبال الحركات متوقف من إعدادات الإضافة في الموقع'));
			return null;
		}

		$raw = file_get_contents('php://input');
		$body = json_decode($raw, true);

		if (!is_array($body)) {
			$this->output(400, array('ok' => false, 'error' => 'bad_request', 'message' => 'طلب غير صالح'));
			return null;
		}

		$key = (string)$this->config->get('module_hudoor_api_key');
		$given = isset($body['key']) ? (string)$body['key'] : '';

		if ($key === '' || !$this->equals($key, $given)) {
			$this->output(401, array('ok' => false, 'error' => 'bad_key', 'message' => 'مفتاح الربط غير صحيح'));
			return null;
		}

		return $body;
	}

	private function equals($a, $b) {
		if (function_exists('hash_equals')) {
			return hash_equals($a, $b);
		}

		return $a === $b;
	}

	private function output($code, $json) {
		if (function_exists('http_response_code')) {
			http_response_code($code);
		}

		$this->response->addHeader('Access-Control-Allow-Origin: *');
		$this->response->addHeader('Access-Control-Allow-Methods: POST, OPTIONS');
		$this->response->addHeader('Access-Control-Allow-Headers: Content-Type');
		$this->response->addHeader('Cache-Control: no-store');
		$this->response->addHeader('Content-Type: application/json; charset=utf-8');
		$this->response->setOutput(json_encode($json));
	}
}
