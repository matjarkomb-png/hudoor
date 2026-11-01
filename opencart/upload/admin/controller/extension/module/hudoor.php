<?php
/**
 * حضور — إضافة تسجيل دوام الموظفين بالتعرف على الوجه
 * OpenCart 3.0.x
 */
class ControllerExtensionModuleHudoor extends Controller {
	private $error = array();

	private $days = array('الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت');

	// ===== صفحة الإعدادات =====
	public function index() {
		$this->load->language('extension/module/hudoor');
		$this->document->setTitle($this->language->get('heading_title'));
		$this->load->model('setting/setting');

		if (($this->request->server['REQUEST_METHOD'] == 'POST') && $this->validate()) {
			$key = $this->config->get('module_hudoor_api_key');

			if (!empty($this->request->post['regenerate']) || !$key) {
				$key = $this->generateKey();
			}

			$this->model_setting_setting->editSetting('module_hudoor', array(
				'module_hudoor_status'  => !empty($this->request->post['module_hudoor_status']) ? 1 : 0,
				'module_hudoor_api_key' => $key
			));

			$this->session->data['success'] = $this->language->get('text_success');

			$this->response->redirect($this->url->link('extension/module/hudoor', 'user_token=' . $this->session->data['user_token'], true));
		}

		// إنشاء الجداول والمفتاح إذا لم تكن موجودة (مثلاً بعد تحديث الملفات)
		$this->load->model('extension/module/hudoor');
		$this->model_extension_module_hudoor->install();

		if (!$this->config->get('module_hudoor_api_key')) {
			$this->model_setting_setting->editSetting('module_hudoor', array(
				'module_hudoor_status'  => 1,
				'module_hudoor_api_key' => $this->generateKey()
			));
			$this->response->redirect($this->url->link('extension/module/hudoor', 'user_token=' . $this->session->data['user_token'], true));
		}

		$data['error_warning'] = isset($this->error['warning']) ? $this->error['warning'] : '';

		if (isset($this->session->data['success'])) {
			$data['success'] = $this->session->data['success'];
			unset($this->session->data['success']);
		} else {
			$data['success'] = '';
		}

		$data['breadcrumbs'] = $this->breadcrumbs();
		$data['action'] = $this->url->link('extension/module/hudoor', 'user_token=' . $this->session->data['user_token'], true);
		$data['cancel'] = $this->url->link('marketplace/extension', 'user_token=' . $this->session->data['user_token'] . '&type=module', true);
		$data['report'] = $this->url->link('extension/module/hudoor/report', 'user_token=' . $this->session->data['user_token'], true);

		$data['module_hudoor_status'] = $this->config->get('module_hudoor_status');
		$data['api_key'] = $this->config->get('module_hudoor_api_key');
		$data['site_url'] = $this->siteUrl();
		$data['connection_code'] = 'HUDOOR|' . $data['site_url'] . '|' . $data['api_key'];

		$stats = $this->model_extension_module_hudoor->getLastSync();
		$data['total_records'] = (int)$stats['total'];
		$data['last_sync'] = $stats['last_sync'];
		$data['employees'] = $this->model_extension_module_hudoor->getEmployees();

		$data['header'] = $this->load->controller('common/header');
		$data['column_left'] = $this->load->controller('common/column_left');
		$data['footer'] = $this->load->controller('common/footer');

		$this->response->setOutput($this->load->view('extension/module/hudoor', $data));
	}

	// ===== تقرير الحضور =====
	public function report() {
		$this->load->language('extension/module/hudoor');
		$this->document->setTitle($this->language->get('text_report'));
		$this->load->model('extension/module/hudoor');
		$this->model_extension_module_hudoor->install();

		$today = date('Y-m-d');
		$filter_date_from = $this->getDate('filter_date_from', date('Y-m-01'));
		$filter_date_to = $this->getDate('filter_date_to', $today);
		$filter_employee_id = isset($this->request->get['filter_employee_id']) ? (string)$this->request->get['filter_employee_id'] : '';
		$view = (isset($this->request->get['view']) && $this->request->get['view'] == 'log') ? 'log' : 'summary';

		$records = $this->model_extension_module_hudoor->getRecords(array(
			'filter_date_from'   => $filter_date_from,
			'filter_date_to'     => $filter_date_to,
			'filter_employee_id' => $filter_employee_id
		));

		$summary = $this->buildSummary($records);

		if (isset($this->request->get['export'])) {
			$this->exportCsv($view, $records, $summary, $filter_date_from, $filter_date_to);
			return;
		}

		$token = 'user_token=' . $this->session->data['user_token'];
		$filter_url = '&filter_date_from=' . urlencode($filter_date_from) . '&filter_date_to=' . urlencode($filter_date_to) . '&filter_employee_id=' . urlencode($filter_employee_id);

		$data['breadcrumbs'] = $this->breadcrumbs();
		$data['breadcrumbs'][] = array('text' => $this->language->get('text_report'), 'href' => $this->url->link('extension/module/hudoor/report', $token, true));

		$data['filter_date_from'] = $filter_date_from;
		$data['filter_date_to'] = $filter_date_to;
		$data['filter_employee_id'] = $filter_employee_id;
		$data['view'] = $view;
		$data['employees'] = $this->model_extension_module_hudoor->getEmployees();
		$data['user_token'] = $this->session->data['user_token'];
		$data['report_base'] = html_entity_decode($this->url->link('extension/module/hudoor/report', $token, true), ENT_QUOTES, 'UTF-8');
		$data['summary_url'] = $this->url->link('extension/module/hudoor/report', $token . $filter_url . '&view=summary', true);
		$data['log_url'] = $this->url->link('extension/module/hudoor/report', $token . $filter_url . '&view=log', true);
		$data['export_url'] = $this->url->link('extension/module/hudoor/report', $token . $filter_url . '&view=' . $view . '&export=1', true);
		$data['settings_url'] = $this->url->link('extension/module/hudoor', $token, true);
		$data['delete_url'] = html_entity_decode($this->url->link('extension/module/hudoor/deleteRecord', $token, true), ENT_QUOTES, 'UTF-8');

		$data['rows'] = array();
		foreach ($summary['rows'] as $r) {
			$data['rows'][] = array(
				'name'     => $r['name'],
				'code'     => $r['code'],
				'day_name' => $this->dayName($r['day']),
				'day'      => $r['day'],
				'first_in' => $r['first_in'] ? $this->time12($r['first_in']) : '—',
				'last_out' => $r['last_out'] ? $this->time12($r['last_out']) : '—',
				'worked'   => $this->duration($r['worked']),
				'missing'  => $r['missing']
			);
		}

		$data['totals'] = array();
		foreach ($summary['totals'] as $t) {
			$data['totals'][] = array('name' => $t['name'], 'code' => $t['code'], 'days' => $t['days'], 'worked' => $this->duration($t['worked']));
		}

		$data['log'] = array();
		foreach (array_reverse($records) as $r) {
			$data['log'][] = array(
				'record_id' => $r['record_id'],
				'name'      => $r['employee_name'],
				'code'      => $r['employee_code'],
				'day_name'  => $this->dayName(substr($r['time_local'], 0, 10)),
				'day'       => substr($r['time_local'], 0, 10),
				'time'      => $this->time12($r['time_local']),
				'type'      => $r['type']
			);
		}

		$data['header'] = $this->load->controller('common/header');
		$data['column_left'] = $this->load->controller('common/column_left');
		$data['footer'] = $this->load->controller('common/footer');

		$this->response->setOutput($this->load->view('extension/module/hudoor_report', $data));
	}

	public function deleteRecord() {
		$this->load->language('extension/module/hudoor');
		$json = array();

		if (!$this->user->hasPermission('modify', 'extension/module/hudoor')) {
			$json['error'] = $this->language->get('error_permission');
		} elseif (empty($this->request->post['record_id'])) {
			$json['error'] = 'missing record_id';
		} else {
			$this->load->model('extension/module/hudoor');
			$this->model_extension_module_hudoor->deleteRecord((string)$this->request->post['record_id']);
			$json['success'] = true;
		}

		$this->response->addHeader('Content-Type: application/json');
		$this->response->setOutput(json_encode($json));
	}

	// ===== التثبيت / الإزالة =====
	public function install() {
		$this->load->model('extension/module/hudoor');
		$this->model_extension_module_hudoor->install();

		$this->load->model('setting/setting');
		$this->model_setting_setting->editSetting('module_hudoor', array(
			'module_hudoor_status'  => 1,
			'module_hudoor_api_key' => $this->generateKey()
		));

		$this->load->model('setting/event');
		$this->model_setting_event->deleteEventByCode('hudoor_menu');
		$this->model_setting_event->addEvent('hudoor_menu', 'admin/view/common/column_left/before', 'extension/module/hudoor/menu');
	}

	public function uninstall() {
		// لا نحذف جداول الحضور حتى لا تضيع السجلات
		$this->load->model('setting/event');
		$this->model_setting_event->deleteEventByCode('hudoor_menu');
	}

	// ===== رابط في القائمة الجانبية =====
	public function menu(&$route, &$data, &$template) {
		if (!isset($this->session->data['user_token']) || !$this->user->hasPermission('access', 'extension/module/hudoor')) {
			return;
		}

		if (!isset($data['menus']) || !is_array($data['menus'])) {
			return;
		}

		$item = array(
			'id'       => 'menu-hudoor',
			'icon'     => 'fa-clock-o',
			'name'     => 'الحضور والانصراف',
			'href'     => '',
			'children' => array(
				array(
					'name'     => 'سجل الحضور',
					'href'     => $this->url->link('extension/module/hudoor/report', 'user_token=' . $this->session->data['user_token'], true),
					'children' => array()
				),
				array(
					'name'     => 'ربط التطبيق',
					'href'     => $this->url->link('extension/module/hudoor', 'user_token=' . $this->session->data['user_token'], true),
					'children' => array()
				)
			)
		);

		// ضع القائمة بعد لوحة التحكم مباشرة
		array_splice($data['menus'], 1, 0, array($item));
	}

	// ===== أدوات مساعدة =====
	protected function validate() {
		if (!$this->user->hasPermission('modify', 'extension/module/hudoor')) {
			$this->error['warning'] = $this->language->get('error_permission');
		}

		return !$this->error;
	}

	private function breadcrumbs() {
		$token = 'user_token=' . $this->session->data['user_token'];

		return array(
			array('text' => $this->language->get('text_home'), 'href' => $this->url->link('common/dashboard', $token, true)),
			array('text' => $this->language->get('text_extension'), 'href' => $this->url->link('marketplace/extension', $token . '&type=module', true)),
			array('text' => $this->language->get('heading_title'), 'href' => $this->url->link('extension/module/hudoor', $token, true))
		);
	}

	private function generateKey() {
		$chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
		$key = '';

		for ($i = 0; $i < 24; $i++) {
			if (function_exists('random_int')) {
				$key .= $chars[random_int(0, strlen($chars) - 1)];
			} else {
				$key .= $chars[mt_rand(0, strlen($chars) - 1)];
			}
		}

		return $key;
	}

	private function siteUrl() {
		if (defined('HTTPS_CATALOG') && HTTPS_CATALOG) {
			$url = HTTPS_CATALOG;
		} else {
			$url = HTTP_CATALOG;
		}

		return rtrim($url, '/') . '/';
	}

	private function getDate($key, $default) {
		if (isset($this->request->get[$key]) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $this->request->get[$key])) {
			return $this->request->get[$key];
		}

		return $default;
	}

	private function dayName($date) {
		$ts = strtotime($date);

		return $ts ? $this->days[(int)date('w', $ts)] : '';
	}

	private function time12($datetime) {
		$ts = strtotime($datetime);

		if (!$ts) {
			return '';
		}

		return date('h:i', $ts) . ' ' . (date('H', $ts) < 12 ? 'ص' : 'م');
	}

	private function duration($seconds) {
		$minutes = (int)round($seconds / 60);

		return floor($minutes / 60) . ':' . str_pad($minutes % 60, 2, '0', STR_PAD_LEFT);
	}

	private function buildSummary($records) {
		$groups = array();

		foreach ($records as $r) {
			$key = $r['employee_id'] . '|' . substr($r['time_local'], 0, 10);
			$groups[$key][] = $r;
		}

		$rows = array();
		$totals = array();

		foreach ($groups as $list) {
			$first_in = null;
			$last_out = null;
			$open = null;
			$worked = 0;
			$missing = false;

			foreach ($list as $r) {
				$t = strtotime($r['time_local']);

				if ($r['type'] == 'in') {
					if ($first_in === null) {
						$first_in = $r['time_local'];
					}
					if ($open !== null) {
						$missing = true;
					}
					$open = $t;
				} else {
					$last_out = $r['time_local'];
					if ($open !== null) {
						$worked += $t - $open;
						$open = null;
					} else {
						$missing = true;
					}
				}
			}

			if ($open !== null) {
				$missing = true;
			}

			$last = end($list);
			$employee_id = $list[0]['employee_id'];

			$rows[] = array(
				'employee_id' => $employee_id,
				'name'        => $last['employee_name'],
				'code'        => $last['employee_code'],
				'day'         => substr($list[0]['time_local'], 0, 10),
				'first_in'    => $first_in,
				'last_out'    => $last_out,
				'worked'      => $worked,
				'missing'     => $missing
			);

			if (!isset($totals[$employee_id])) {
				$totals[$employee_id] = array('name' => $last['employee_name'], 'code' => $last['employee_code'], 'days' => 0, 'worked' => 0);
			}

			$totals[$employee_id]['days']++;
			$totals[$employee_id]['worked'] += $worked;
		}

		usort($rows, function ($a, $b) {
			if ($a['day'] == $b['day']) {
				return strcmp($a['name'], $b['name']);
			}

			return strcmp($a['day'], $b['day']);
		});

		usort($totals, function ($a, $b) {
			return strcmp($a['name'], $b['name']);
		});

		return array('rows' => $rows, 'totals' => $totals);
	}

	private function exportCsv($view, $records, $summary, $from, $to) {
		$lines = array();

		if ($view == 'log') {
			$lines[] = array('الموظف', 'الرقم الوظيفي', 'اليوم', 'التاريخ', 'الوقت', 'الحركة');

			foreach ($records as $r) {
				$day = substr($r['time_local'], 0, 10);
				$lines[] = array($r['employee_name'], $r['employee_code'], $this->dayName($day), $day, $this->time12($r['time_local']), $r['type'] == 'in' ? 'دخول' : 'خروج');
			}
		} else {
			$lines[] = array('الموظف', 'الرقم الوظيفي', 'اليوم', 'التاريخ', 'أول دخول', 'آخر خروج', 'ساعات العمل', 'ملاحظة');

			foreach ($summary['rows'] as $r) {
				$lines[] = array($r['name'], $r['code'], $this->dayName($r['day']), $r['day'],
					$r['first_in'] ? $this->time12($r['first_in']) : '', $r['last_out'] ? $this->time12($r['last_out']) : '',
					$this->duration($r['worked']), $r['missing'] ? 'حركة ناقصة' : '');
			}

			$lines[] = array();
			$lines[] = array('الإجمالي', 'الرقم الوظيفي', 'أيام الحضور', '', '', '', 'مجموع الساعات', '');

			foreach ($summary['totals'] as $t) {
				$lines[] = array($t['name'], $t['code'], $t['days'], '', '', '', $this->duration($t['worked']), '');
			}
		}

		$fh = fopen('php://temp', 'r+');
		fwrite($fh, "\xEF\xBB\xBF");

		foreach ($lines as $line) {
			fputcsv($fh, $line);
		}

		rewind($fh);
		$csv = stream_get_contents($fh);
		fclose($fh);

		$filename = 'hudoor_' . $from . '_' . $to . '.csv';

		$this->response->addHeader('Content-Type: text/csv; charset=utf-8');
		$this->response->addHeader('Content-Disposition: attachment; filename="' . $filename . '"');
		$this->response->setOutput($csv);
	}
}
